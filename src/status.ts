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
import type { AppStatus, MediaFolderStatus, Settings } from './types.js';
import { APP_VERSION, GIT_SHA } from './version.js';

/** The single source of truth for "is the whole media path healthy right now". */
export function isHealthy(s: AppStatus): boolean {
  return (
    s.mount.mounted &&
    !s.mount.stale &&
    s.plex.bindOk &&
    s.bootHook.ok &&
    s.composePatch.ok &&
    s.media.ok
  );
}

/** A mount is stale if its backing device no longer matches the live by-uuid device. */
function computeStale(mounted: boolean, present: boolean, device: string | null, source: string): boolean {
  if (!mounted) return false;
  // Mounted but the drive's by-uuid symlink is gone entirely -> definitely stale.
  if (!present) return true;
  if (device === null || source === '') return false;
  return source !== device;
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

export async function probeStatus(adapter: HostAdapter, settings: Settings): Promise<AppStatus> {
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
  const stale = computeStale(mounted, present, device, source);

  // --- Boot hook ------------------------------------------------------------
  const hookP = hookPath(settings);
  const existingHook = await adapter.readFile(hookP);
  const hookResult = ensureHookBlock(existingHook, {
    uuid: settings.uuid,
    mountPoint: settings.mountPoint,
    fsType: settings.fsType,
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
  const inspect = await adapter.inspectPlex(settings.plexAppId);
  const bindOk =
    inspect.found &&
    inspect.state === 'running' &&
    inspect.binds.some((b) => b.destination === settings.containerMediaPath);

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
  };
}
