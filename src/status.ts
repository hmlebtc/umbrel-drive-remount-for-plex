/**
 * Status probe (spec section 6) — builds the AppStatus that the dashboard,
 * the /api/status route, the restore verify step and the monitor all consume.
 *
 * Every host read goes through the HostAdapter, so this whole module runs
 * unchanged against the in-memory mock. Nothing here mutates host state.
 */

import { posix } from 'node:path';

import { ensureHookBlock } from './bootHook.js';
import { ensureVolumeLine } from './composePatch.js';
import type { HostAdapter } from './hostAdapter.js';
import { findMount, parseProcMounts } from './mounts.js';
import {
  byUuidPath,
  composePath,
  FSTAB_PATH,
  hookPath,
  hostMediaPath,
  legacyOverridePath,
} from './paths.js';
import { probeLiveOk } from './plex.js';
import type {
  AppStatus,
  BackingStatus,
  MediaFolderStatus,
  Settings,
  WarningCode,
} from './types.js';
import { APP_VERSION, GIT_SHA } from './version.js';

/**
 * The single source of truth for "is the whole media path healthy right now".
 *
 * Mode-aware (spec section 8): classic keeps the v0.1.x criteria byte-for-byte;
 * cooperative additionally requires the bind to be active on the live umbrelOS
 * mount. Both gain the in-container liveness gate — a PROBED-dead view
 * (`plex.liveOk === false`) fails health so Plex is recreated; an unset/true
 * liveOk never newly fails health (backward compatible).
 */
export function isHealthy(s: AppStatus): boolean {
  const base =
    s.plex.bindOk &&
    s.bootHook.ok &&
    s.composePatch.ok &&
    s.media.ok &&
    s.plex.liveOk !== false;

  const mode = s.backing?.mode ?? 'classic';
  if (mode === 'cooperative') {
    const b = s.backing;
    const backingHealthy =
      b.active === 'umbrel-bind' &&
      b.umbrelMount.found &&
      b.umbrelMount.readable &&
      s.mount.mounted &&
      !s.mount.stale;
    return base && backingHealthy;
  }
  return s.mount.mounted && !s.mount.stale && base;
}

/**
 * A mount is stale (spec sections 2, 7) when, being mounted, any of:
 *   - the drive's by-uuid symlink is gone entirely (drive detached), or
 *   - the mount target is unreadable via the adapter (EIO — device yanked out
 *     from under a live mount; see {@link probeMountReadable}), or
 *   - the backing device no longer matches the live by-uuid device
 *     (re-enumerated after a replug).
 *
 * This ONE helper is shared by status.ts (probeStatus) and restore.ts
 * (ensureMount) so both agree on exactly what "stale" means.
 */
export function computeStale(
  mounted: boolean,
  present: boolean,
  device: string | null,
  source: string,
  targetReadable: boolean,
): boolean {
  if (!mounted) return false;
  if (!present) return true;
  if (!targetReadable) return true;
  if (device === null || source === '') return false;
  return source !== device;
}

/**
 * EIO probe: is the mount target readable via the adapter? A live, healthy
 * mount lists its root directory (even an empty mount returns `[]`); a mount
 * whose backing device has gone away errors and lists as `null`. Only meaningful
 * when the target is actually mounted.
 */
export async function probeMountReadable(adapter: HostAdapter, mountPoint: string): Promise<boolean> {
  return (await adapter.listDir(mountPoint)) !== null;
}

async function detectFstabEntry(adapter: HostAdapter, settings: Settings): Promise<boolean> {
  const fstab = await adapter.readFile(FSTAB_PATH);
  if (fstab === null) return false;
  for (const raw of fstab.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (settings.uuid !== '' && line.includes(settings.uuid)) return true;
    const fields = line.split(/\s+/);
    if (fields.includes(settings.mountPoint)) return true;
  }
  return false;
}

/**
 * Optional precomputed backing (spec section 8). The server and monitor pass the
 * BackingEngine's authoritative backing + warnings; callers without an engine
 * (the restore job's internal probes, unit tests) omit it and get a classic
 * default derived from the plain mount table.
 */
export interface ProbeOptions {
  backing?: { backing: BackingStatus; warnings: WarningCode[] };
}

export async function probeStatus(
  adapter: HostAdapter,
  settings: Settings,
  opts: ProbeOptions = {},
): Promise<AppStatus> {
  const timestamp = new Date().toISOString();

  // --- Drive presence -------------------------------------------------------
  const uuidLink = byUuidPath(settings);
  const present = settings.uuid !== '' && (await adapter.exists(uuidLink));
  const device = present ? await adapter.realpath(uuidLink) : null;

  // --- Mount ----------------------------------------------------------------
  const entries = parseProcMounts(await adapter.readProcMounts());
  const entry = findMount(entries, settings.mountPoint);
  const mounted = entry !== null;
  const source = entry?.source ?? '';
  const rw = entry ? entry.options.includes('rw') && !entry.options.includes('ro') : false;
  const mountFsType = entry?.fsType ?? settings.fsType;
  const targetReadable = mounted ? await probeMountReadable(adapter, settings.mountPoint) : true;
  const stale = computeStale(mounted, present, device, source, targetReadable);

  // --- Boot hook ------------------------------------------------------------
  const hookP = hookPath(settings);
  const existingHook = await adapter.readFile(hookP);
  const hookResult = ensureHookBlock(existingHook, {
    uuid: settings.uuid,
    mountPoint: settings.mountPoint,
    fsType: settings.fsType,
    mountMode: settings.mountMode ?? 'classic',
  });
  const hookOk = existingHook !== null && !hookResult.changed;
  const hookProblems = hookOk
    ? []
    : [existingHook === null ? 'boot hook file is missing' : 'boot hook block is missing or outdated'];

  // --- Compose patch --------------------------------------------------------
  const compP = composePath(settings);
  const composeText = await adapter.readFile(compP);
  const legacyOverridePresent = await adapter.exists(legacyOverridePath(settings));
  const legacyFstabEntryPresent = await detectFstabEntry(adapter, settings);

  let patchOk = false;
  let patchProblems: string[] = [];
  if (composeText === null) {
    patchProblems = [`Plex compose file not found at ${compP}`];
  } else {
    const r = ensureVolumeLine(composeText, {
      hostPath: hostMediaPath(settings),
      containerPath: settings.containerMediaPath,
    });
    if (r.problems.length > 0) {
      patchProblems = r.problems;
    } else if (r.alreadyPresent) {
      patchOk = true;
    } else {
      patchProblems = ['media bind is not present in the Plex compose file'];
    }
  }

  // --- Plex container -------------------------------------------------------
  // A bind counts only when BOTH ends match: the host source must be our media
  // path AND the container destination must be containerMediaPath (a stale
  // source pointing elsewhere means the media is not actually visible).
  const inspect = await adapter.inspectPlex(settings.plexAppId);
  const wantBindSource = hostMediaPath(settings);
  const bindOk =
    inspect.found &&
    inspect.state === 'running' &&
    inspect.binds.some(
      (b) => b.source === wantBindSource && b.destination === settings.containerMediaPath,
    );

  // In-container liveness (spec section 5): distinct from config-level bindOk.
  // Only probed when Plex is actually running; otherwise `true` so it never
  // becomes the sole health discriminator (bindOk already covers not-running).
  const liveOk =
    inspect.found && inspect.state === 'running' && inspect.containerName !== null
      ? await probeLiveOk(adapter, settings, inspect.containerName)
      : true;

  // --- Media folders --------------------------------------------------------
  const mediaRoot = hostMediaPath(settings);
  const active = mounted && !stale;
  const folders: MediaFolderStatus[] = [];
  let allFoldersPresent = true;
  for (const name of settings.folders) {
    const folderPath = posix.join(mediaRoot, name);
    const folderPresent = active ? await adapter.exists(folderPath) : false;
    const list = folderPresent ? await adapter.listDir(folderPath) : null;
    if (!folderPresent) allFoldersPresent = false;
    folders.push({ name, present: folderPresent, entries: list?.length ?? 0 });
  }
  const mediaOk = active && allFoldersPresent;

  // --- Backing + warnings ---------------------------------------------------
  // Prefer the engine-supplied authoritative backing; otherwise derive a classic
  // default from the plain mount table (keeps unit tests / the restore job's
  // internal probes self-contained without an engine).
  const mode = settings.mountMode ?? 'classic';
  const defaultBacking: BackingStatus = {
    mode,
    active: mounted ? 'direct' : 'none',
    umbrelMount: { found: false, path: null, readable: false },
    bindGeneration: 0,
    lastBindChangeAt: null,
    reaped: { dirs: 0, mounts: 0 },
  };
  const defaultWarnings: WarningCode[] =
    mode === 'classic' && present && mounted ? ['FORMAT_DIALOG_EXPECTED'] : [];
  const backing = opts.backing?.backing ?? defaultBacking;
  const warnings = opts.backing?.warnings ?? defaultWarnings;

  return {
    timestamp,
    version: APP_VERSION,
    gitSha: GIT_SHA,
    drive: { present, device },
    mount: { mounted, stale, source, target: settings.mountPoint, fsType: mountFsType, rw },
    bootHook: { ok: hookOk, path: hookP, problems: hookProblems },
    composePatch: {
      ok: patchOk,
      path: compP,
      problems: patchProblems,
      legacyOverridePresent,
      legacyFstabEntryPresent,
    },
    plex: {
      found: inspect.found,
      containerName: inspect.containerName,
      state: inspect.state,
      bindOk,
      binds: inspect.binds,
      startedAt: inspect.startedAt,
      liveOk,
    },
    media: { ok: mediaOk, folders },
    autoHeal: {
      enabled: settings.autoHeal.enabled,
      lastCheckAt: null,
      lastActionAt: null,
      consecutiveFailures: 0,
      suspended: false,
    },
    lastRestore: null,
    backing,
    warnings,
  };
}
