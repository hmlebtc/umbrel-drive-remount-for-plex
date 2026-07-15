/**
 * The stateful backing engine (spec sections 3, 4, 5, 6, 10).
 *
 * Owns /data/backing.json (atomic), applies the A-E ladder decisions with the
 * section-10 safety rails (umount ONLY our recorded target or a provably-dead
 * mount; rmdir ONLY empty+unmounted+label-matched dirs under externalBase; sysfs
 * replug ONLY when the device holds zero live mounts), and drives Plex recreates
 * on a bind change or the bind-generation / liveness rule.
 *
 * The PURE decision logic lives in backing.ts; this module is the side-effecting
 * shell around it. Every host mutation goes through the HostAdapter, so the whole
 * engine runs in-memory against mockAdapter.ts.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { performance } from 'node:perf_hooks';

import { backingDecide, classifyBacking, parseMountInfo } from './backing.js';
import type { EventLog } from './events.js';
import type { HostAdapter } from './hostAdapter.js';
import { findMount, parseProcMounts } from './mounts.js';
import { byUuidPath, externalBase, sanitizeLabel } from './paths.js';
import { probeLiveOk, recreatePlex } from './plex.js';
import { classifyLeftover, matchesLabel, reapPlan, type LeafScan, type ReapEntry } from './reap.js';
import type {
  AppStatus,
  BackingDecision,
  BackingRecord,
  BackingStatus,
  BackingView,
  MountInfoEntry,
  ReapCounts,
  Settings,
  WarningCode,
} from './types.js';

/** A per-step log sink (the migration job passes its own; the monitor passes events). */
export type LogSink = (line: string) => void;

const NOOP_LOG: LogSink = () => {};

/** Cap the number of externalBase entries considered per reap (bounded, section 4). */
const REAP_SCAN_LIMIT = 64;

/**
 * Bounds for the recursive leftover-subtree walk (spec §4, v0.2.1). Hitting
 * either cap means we could NOT fully prove the tree empty, so it is treated as
 * has-files and never auto-cleared. `<externalBase>/<label>` skeletons are a
 * handful of empty dirs; these caps only ever fire on an unexpectedly large tree.
 */
const SCAN_DEPTH_CAP = 12;
const SCAN_NODE_CAP = 5000;

/** Bounds for {@link BackingEngine.scanLeftover} (defaults to the §4 caps). */
export interface ScanBounds {
  depthCap?: number;
  nodeCap?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The `major:minor` of our by-uuid device as it appears in the live mount table
 * (F7). Derived from any mountinfo entry whose SOURCE already equals the device,
 * so a second entry with a differently-canonicalized source but the same maj:min
 * still resolves to our device. Null when the drive is absent or unseen.
 */
function deviceMajMinOf(entries: MountInfoEntry[], device: string | null): string | null {
  if (device === null) return null;
  for (const e of entries) {
    if (e.source === device) return e.majorMinor;
  }
  return null;
}

/**
 * Single-quote a sysfs path for a `sh -c` redirect. Paths come only from the
 * /sys tree walk (never user input); we still quote as defense in depth and a
 * literal `'` — impossible in a sysfs path — would be neutralised by the
 * close-reopen idiom.
 */
function shquote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function defaultRecord(mode: Settings['mountMode']): BackingRecord {
  return {
    mode,
    active: 'none',
    boundTo: null,
    bindGeneration: 0,
    lastBindChangeAt: null,
    graceStartedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export class BackingStore {
  private record: BackingRecord;

  constructor(private readonly dataDir: string | undefined, mode: Settings['mountMode']) {
    this.record = this.load(mode);
  }

  private path(): string | null {
    return this.dataDir ? join(this.dataDir, 'backing.json') : null;
  }

  private load(mode: Settings['mountMode']): BackingRecord {
    const p = this.path();
    if (!p || !existsSync(p)) return defaultRecord(mode);
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<BackingRecord>;
      return { ...defaultRecord(mode), ...parsed };
    } catch {
      return defaultRecord(mode);
    }
  }

  get(): BackingRecord {
    return this.record;
  }

  /** Atomic tmp+rename write; best-effort (never throws out to a host mutation). */
  set(next: BackingRecord): void {
    this.record = next;
    const p = this.path();
    if (!p) return;
    try {
      mkdirSync(dirname(p), { recursive: true });
      const tmp = `${p}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
      renameSync(tmp, p);
    } catch {
      /* keep the in-memory record even if persistence fails */
    }
  }
}

// ---------------------------------------------------------------------------
// Pure liveness-recreate rule (spec section 5)
// ---------------------------------------------------------------------------

/**
 * Section 5 recreate rule. Recreate Plex when it is running but either:
 *   - it started BEFORE our last bind change (holds the pre-bind, dead view), or
 *   - its in-container view is dead (liveOk false) while host-side media is fine.
 */
export function plexNeedsRecreate(
  status: AppStatus,
  record: BackingRecord,
): { recreate: boolean; reason: string } {
  if (!status.plex.found || status.plex.state !== 'running') {
    return { recreate: false, reason: 'plex not running' };
  }
  if (record.lastBindChangeAt && status.plex.startedAt) {
    const started = Date.parse(status.plex.startedAt);
    const bound = Date.parse(record.lastBindChangeAt);
    if (Number.isFinite(started) && Number.isFinite(bound) && started < bound) {
      return { recreate: true, reason: 'Plex started before the last bind change (holds a dead view)' };
    }
  }
  if (status.plex.liveOk === false && status.media.ok) {
    return { recreate: true, reason: 'in-container media view is dead (liveOk false) while host media is healthy' };
  }
  return { recreate: false, reason: 'Plex view is live' };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface EvaluateResult {
  view: BackingView;
  decision: BackingDecision;
  device: string | null;
  drivePresent: boolean;
  graceRemainingSec: number;
  umbrelReadable: boolean;
}

export class BackingEngine {
  private readonly store: BackingStore;
  private reaped: ReapCounts = { dirs: 0, mounts: 0 };
  private drivePresentPrev: boolean | null = null;
  private bootChecked = false;
  /**
   * F3: the grace window is anchored to an in-memory MONOTONIC clock set at this
   * boot (engine construction / drive-arrival / handover), NEVER to a persisted
   * wall-clock. A power loss during grace → fresh process → anchor null → the
   * first tick starts a full fresh window; an RTC skew can never make grace fire
   * early or never (the value is clamped to [0, graceSec]). graceStartedAt stays
   * in the record purely as the "an arrival-flow grace was started" marker the
   * ladder reads (never as the timer source).
   */
  private graceAnchorMono: number | null = null;

  constructor(
    private readonly adapter: HostAdapter,
    private readonly getSettings: () => Settings,
    private readonly events?: EventLog,
    dataDir?: string,
  ) {
    this.store = new BackingStore(dataDir, getSettings().mountMode ?? 'classic');
  }

  getRecord(): BackingRecord {
    return this.store.get();
  }

  private activity(level: 'info' | 'warn' | 'error', message: string): void {
    this.events?.[level]('backing', message);
  }

  private persist(patch: Partial<BackingRecord>): void {
    const settings = this.getSettings();
    this.store.set({ ...this.store.get(), mode: settings.mountMode ?? 'classic', ...patch });
  }

  // --- grace ---------------------------------------------------------------

  private startGrace(force: boolean): void {
    if (force || this.graceAnchorMono === null) {
      // Anchor the timer to the monotonic clock (F3); persist graceStartedAt only
      // as the arrival-flow marker the ladder reads.
      this.graceAnchorMono = performance.now();
      this.persist({ graceStartedAt: nowIso() });
    }
  }

  private graceRemainingSec(settings: Settings): number {
    const graceSec = settings.graceSec ?? 180;
    if (this.graceAnchorMono === null) return 0;
    const elapsed = Math.floor((performance.now() - this.graceAnchorMono) / 1000);
    // Clamp to [0, graceSec]: never negative (stale anchor), never > graceSec
    // (a future-dated / RTC-skewed anchor can't produce a multi-day wait).
    return Math.min(graceSec, Math.max(0, graceSec - elapsed));
  }

  // --- discovery -----------------------------------------------------------

  private async device(settings: Settings): Promise<string | null> {
    return this.adapter.realpath(byUuidPath(settings));
  }

  private async mountInfo(): Promise<MountInfoEntry[]> {
    return parseMountInfo(await this.adapter.readProcMountInfo());
  }

  /**
   * Pure-ish classification: resolve the device, parse mountinfo, classify, and
   * layer the live readability probe onto umbrelMount.found (an unreadable
   * umbrelOS mount is not a usable bind target). No grace mutation, no decide —
   * safe to call in a tight poll loop (e.g. the migration's wait-for-mount).
   */
  async classify(settings: Settings): Promise<{
    view: BackingView;
    device: string | null;
    drivePresent: boolean;
    umbrelReadable: boolean;
  }> {
    const device = await this.device(settings);
    const drivePresent = device !== null;
    const entries = await this.mountInfo();
    const view = classifyBacking(entries, {
      device,
      mountPoint: settings.mountPoint,
      externalBase: externalBase(settings),
      record: this.store.get(),
      deviceMajMin: deviceMajMinOf(entries, device),
    });

    let umbrelReadable = false;
    if (view.umbrelMount.found && view.umbrelMount.path !== null) {
      umbrelReadable = (await this.adapter.listDir(view.umbrelMount.path)) !== null;
      if (!umbrelReadable) {
        view.umbrelMount = { found: false, path: null, mountId: null, source: null };
      }
    }
    return { view, device, drivePresent, umbrelReadable };
  }

  /**
   * Classify the current backing and pick the ladder action. Manages the grace
   * window (started only on boot / drive-arrival, never restarted after an eject).
   */
  async evaluate(settings: Settings): Promise<EvaluateResult> {
    const { view, device, drivePresent, umbrelReadable } = await this.classify(settings);

    // Grace management (in-memory transition tracking + persisted timestamp).
    const sp = view.stablePath;
    const correctlyBound =
      sp.bindOfUmbrel && !sp.stale && !sp.boundElsewhere && view.umbrelMount.found &&
      this.store.get().boundTo === view.umbrelMount.path;
    const healthyDirect = sp.direct && !sp.stale;
    const waiting = drivePresent && !correctlyBound && !healthyDirect && !view.umbrelMount.found;
    const arrival = this.drivePresentPrev === false && drivePresent;
    if ((settings.mountMode ?? 'classic') === 'cooperative' && waiting) {
      const rec = this.store.get();
      const ejectedState = rec.active === 'none' && rec.boundTo !== null;
      if (arrival) this.startGrace(true);
      else if (!this.bootChecked && !ejectedState) this.startGrace(false);
    }
    this.bootChecked = true;
    this.drivePresentPrev = drivePresent;

    const rec = this.store.get();
    const sinceLastHandoverSec = rec.lastBindChangeAt
      ? Math.floor((Date.now() - Date.parse(rec.lastBindChangeAt)) / 1000)
      : Number.MAX_SAFE_INTEGER;
    const graceRemainingSec = this.graceRemainingSec(settings);

    const decision = backingDecide(view, {
      mode: settings.mountMode ?? 'classic',
      drivePresent,
      graceRemainingSec,
      plexRunning: await this.plexRunning(settings),
      sinceLastHandoverSec,
    });

    return { view, decision, device, drivePresent, graceRemainingSec, umbrelReadable };
  }

  private async plexRunning(settings: Settings): Promise<boolean> {
    const inspect = await this.adapter.inspectPlex(settings.plexAppId);
    return inspect.found && inspect.state === 'running';
  }

  /** Mountpoints of every LIVE mount of our device (migration replug precondition). */
  async deviceLiveMounts(settings: Settings): Promise<string[]> {
    const device = await this.device(settings);
    if (device === null) return [];
    const entries = await this.mountInfo();
    return entries.filter((e) => e.source === device).map((e) => e.mountpoint);
  }

  /**
   * F2: mountpoints of EVERY live mount whose source is under our physical DISK
   * — the whole-disk partition set (/dev/<disk>, /dev/<disk><N>, /dev/<disk>p<N>).
   * The sysfs replug de-authorizes the WHOLE USB disk, so ANY mounted sibling
   * partition (swap, a second Files mount, another fs) MUST veto it — the
   * partition-scoped {@link deviceLiveMounts} guard is not sufficient.
   */
  async diskLiveMounts(settings: Settings): Promise<string[]> {
    const device = await this.device(settings);
    if (device === null) return [];
    const disk = this.diskOf(device);
    if (disk === null) return [];
    const re = new RegExp(`^/dev/${escapeRegExp(disk)}(p?\\d+)?$`);
    const entries = await this.mountInfo();
    return entries.filter((e) => re.test(e.source)).map((e) => e.mountpoint);
  }

  /** `umount -l <target>`; returns whether it succeeded. Used by the migration job. */
  async lazyUmount(target: string, log: LogSink = NOOP_LOG): Promise<boolean> {
    const u = await this.adapter.exec(['umount', '-l', target]);
    if (u.code !== 0) {
      log(`umount -l ${target} returned ${u.code}: ${u.stderr.trim()}`);
      return false;
    }
    log(`unmounted ${target}`);
    return true;
  }

  // --- ladder actions (with section-10 safety rails) -----------------------

  /**
   * Unmount the stable path ONLY when it is ours (a recorded direct/bind) or
   * provably dead (stale). Refuses to touch an unrecognised LIVE mount.
   */
  private async teardownStablePath(view: BackingView, settings: Settings, log: LogSink): Promise<boolean> {
    const sp = view.stablePath;
    if (!sp.mounted) return true;
    const ours = sp.direct || sp.bindOfUmbrel;
    if (!ours && !sp.stale) {
      log(`refusing to unmount ${settings.mountPoint}: an unrecognised live mount is present (not ours)`);
      this.activity('warn', `refused to unmount ${settings.mountPoint} (unrecognised live mount)`);
      return false;
    }
    const u = await this.adapter.exec(['umount', '-l', settings.mountPoint]);
    if (u.code !== 0) log(`umount -l ${settings.mountPoint} returned ${u.code}: ${u.stderr.trim()}`);
    else log(`unmounted ${settings.mountPoint}`);
    return true;
  }

  /** Ladder A/D: bind the stable path to a live umbrelOS mount. Returns success. */
  async doBind(umbrelPath: string, view: BackingView, settings: Settings, log: LogSink): Promise<boolean> {
    if (!(await this.teardownStablePath(view, settings, log))) return false;
    await this.adapter.exec(['mkdir', '-p', settings.mountPoint]);
    const m = await this.adapter.exec(['mount', '--bind', umbrelPath, settings.mountPoint]);
    if (m.code !== 0) {
      log(`mount --bind failed (code ${m.code}): ${m.stderr.trim()}`);
      return false;
    }
    const rec = this.store.get();
    this.persist({
      active: 'umbrel-bind',
      boundTo: umbrelPath,
      bindGeneration: rec.bindGeneration + 1,
      lastBindChangeAt: nowIso(),
      graceStartedAt: null,
    });
    log(`bound ${settings.mountPoint} -> ${umbrelPath} (bindGeneration ${rec.bindGeneration + 1})`);
    this.activity('info', `bound stable path to umbrelOS mount ${umbrelPath}`);
    return true;
  }

  /** Ladder C: classic direct mount fallback by UUID. Returns success. */
  async doDirectMount(view: BackingView, settings: Settings, log: LogSink): Promise<boolean> {
    // Only tear down a stale/ours mount first; a healthy direct is a no-op.
    if (view.stablePath.mounted && view.stablePath.stale) {
      if (!(await this.teardownStablePath(view, settings, log))) return false;
    }
    await this.adapter.exec(['mkdir', '-p', settings.mountPoint]);
    const dev = byUuidPath(settings);
    const m = await this.adapter.exec(['mount', '-t', settings.fsType, dev, settings.mountPoint]);
    if (m.code !== 0) {
      log(`direct mount failed (code ${m.code}): ${m.stderr.trim()}`);
      return false;
    }
    // F5: never trust the exit code — re-parse /proc/1/mounts and confirm the
    // mount actually materialized before persisting active='direct'. A backing
    // state the mount table doesn't corroborate is worse than a reported failure
    // (Plex would be dark while status claims 'direct').
    const after = findMount(parseProcMounts(await this.adapter.readProcMounts()), settings.mountPoint);
    if (after === null) {
      log(`direct mount reported success (code 0) but ${settings.mountPoint} is absent from the mount table — not persisting 'direct'`);
      this.activity('error', `direct mount of ${settings.mountPoint} could not be verified — Plex has no backing; reconnect the drive`);
      return false;
    }
    const rec = this.store.get();
    this.persist({
      active: 'direct',
      boundTo: null,
      bindGeneration: rec.bindGeneration + 1,
      lastBindChangeAt: nowIso(),
      graceStartedAt: null,
    });
    log(`direct-mounted ${dev} at ${settings.mountPoint} (classic fallback)`);
    this.activity('warn', 'classic direct fallback engaged (umbrelOS did not mount the drive)');
    return true;
  }

  /** Ladder E: release our stale bind on an eject / umbreld restart. Returns success. */
  async doRelease(view: BackingView, settings: Settings, log: LogSink): Promise<boolean> {
    if (view.stablePath.mounted && view.stablePath.bindOfUmbrel) {
      const u = await this.adapter.exec(['umount', '-l', settings.mountPoint]);
      if (u.code !== 0) log(`umount -l ${settings.mountPoint} returned ${u.code}: ${u.stderr.trim()}`);
    }
    // Keep boundTo (as an "ejected" marker so boot does not restart grace) but
    // clear the active backing + grace window.
    this.persist({ active: 'none', graceStartedAt: null, lastBindChangeAt: nowIso() });
    log(`released bind at ${settings.mountPoint}; awaiting umbrelOS remount`);
    this.activity('warn', 'drive ejected/unmounted in umbrelOS — released our bind, awaiting remount');
    return true;
  }

  /** Recreate Plex (used after a bind change or the liveness rule). */
  async recreate(settings: Settings, log: LogSink = NOOP_LOG): Promise<boolean> {
    const r = await recreatePlex(this.adapter, settings);
    log(r.message);
    if (r.ok) this.activity('info', 'recreated Plex to pick up the new backing');
    else this.activity('error', `Plex recreate failed: ${r.message}`);
    return r.ok;
  }

  // --- reaping (spec section 4) --------------------------------------------

  /**
   * The label reaping matches names against (F8): the drive's real sanitized FS
   * label (settings.driveLabel, seeded "wdexternal"), falling back to
   * basename(mountPoint) only when it is empty — so a drive whose label differs
   * from the mount-point basename still has its drift dirs reaped.
   */
  private reapLabel(settings: Settings): string {
    const explicit = (settings.driveLabel ?? '').trim();
    return explicit !== '' ? explicit : posix.basename(settings.mountPoint);
  }

  /**
   * Recursively walk a leftover subtree via listDir + statType (spec §4,
   * v0.2.1), returning the descendant node list {@link classifyLeftover}
   * consumes. Bounded by depth (12) and node count (5000); on hitting EITHER cap,
   * or on an unreadable directory (can't prove empty), a non-directory sentinel
   * node is appended so the tree classifies as has-files — we never auto-clear
   * what we could not fully verify empty. statType (lstat) makes a symlink read
   * as 'symlink' (never dereferenced), so a symlink to a directory is a file, not
   * an empty dir. The walk is strictly scoped to `dir` and its descendants.
   */
  async scanLeftover(dir: string, bounds: ScanBounds = {}): Promise<LeafScan> {
    const depthCap = bounds.depthCap ?? SCAN_DEPTH_CAP;
    const nodeCap = bounds.nodeCap ?? SCAN_NODE_CAP;
    const nodes: LeafScan = [];
    const stack: { path: string; depth: number }[] = [{ path: dir, depth: 0 }];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      const names = await this.adapter.listDir(cur.path);
      if (names === null) {
        // Unreadable / not a directory: we cannot prove it empty -> has-files.
        nodes.push({ path: cur.path, type: 'other' });
        return nodes;
      }
      for (const name of names) {
        if (nodes.length >= nodeCap) {
          nodes.push({ path: cur.path, type: 'other' }); // node cap -> has-files
          return nodes;
        }
        const child = posix.join(cur.path, name);
        const type = await this.adapter.statType(child);
        if (type === null) continue; // vanished between listDir and statType
        nodes.push({ path: child, type });
        if (type === 'dir') {
          if (cur.depth + 1 >= depthCap) {
            nodes.push({ path: child, type: 'other' }); // depth cap -> has-files
            return nodes;
          }
          stack.push({ path: child, depth: cur.depth + 1 });
        }
      }
    }
    return nodes;
  }

  /**
   * Bottom-up (deepest-first) rmdir of an all-empty leftover tree (spec §4,
   * v0.2.1). Two independent data-safety guarantees:
   *   1. pre-check — re-scans the tree and REFUSES unless it is empty-tree, and
   *   2. execution — removal is `adapter.removeDir` (rmdir, NON-recursive), which
   *      physically cannot delete a file or a non-empty directory.
   * Aborts (returns false, nothing further removed) if ANY rmdir fails. Strictly
   * scoped to `dir` and its descendants — never ascends or escapes.
   */
  async clearEmptyTree(dir: string, log: LogSink = NOOP_LOG): Promise<boolean> {
    const scan = await this.scanLeftover(dir);
    if (classifyLeftover(scan) !== 'empty-tree') {
      log(`clearEmptyTree refused ${dir}: subtree is not all-empty-directories (contains files)`);
      return false;
    }
    // Every directory to remove: the descendants (all dirs, since empty-tree) plus
    // the root itself, deepest-first so children go before parents.
    const targets = scan.filter((n) => n.type === 'dir').map((n) => n.path);
    targets.push(dir);
    targets.sort((a, b) => b.split('/').length - a.split('/').length);
    const prefix = `${dir}/`;
    for (const target of targets) {
      // Scope rail: refuse anything not equal to / under the matched leftover dir.
      if (target !== dir && !target.startsWith(prefix)) {
        log(`clearEmptyTree aborted: ${target} is outside the scoped leftover ${dir}`);
        return false;
      }
      try {
        await this.adapter.removeDir(target); // rmdir — fails on any non-empty dir
      } catch (e) {
        log(`clearEmptyTree aborted: rmdir ${target} failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    }
    return true;
  }

  async reap(settings: Settings, log: LogSink = NOOP_LOG): Promise<ReapCounts> {
    const base = externalBase(settings);
    const names = await this.adapter.listDir(base);
    if (names === null) return { dirs: 0, mounts: 0 };

    const entries = await this.mountInfo();
    const mountedAt = new Map<string, MountInfoEntry>();
    // Newest mountId wins (the top-of-stack mount owns the mountpoint).
    for (const e of entries) {
      const prev = mountedAt.get(e.mountpoint);
      if (prev === undefined || e.mountId > prev.mountId) mountedAt.set(e.mountpoint, e);
    }

    const label = this.reapLabel(settings);
    const listing: ReapEntry[] = [];
    // Label-matched, UNMOUNTED, NON-empty leftovers: candidates for the v0.2.1
    // empty-tree clear (an unmounted dir can never be the active umbrelMount).
    const nonEmptyLeftovers: string[] = [];
    for (const name of names.slice(0, REAP_SCAN_LIMIT)) {
      const dirPath = posix.join(base, name);
      const mountEntry = mountedAt.get(dirPath) ?? null;
      const mounted = mountEntry !== null;
      const contents = await this.adapter.listDir(dirPath);
      const empty = contents !== null && contents.length === 0;
      const source = mountEntry?.source ?? null;
      // F1: a mounted dir is reapable ONLY when its SOURCE DEVICE is ABSENT (a
      // genuine zombie of our drive). Presence is a real device-node check
      // (adapter.exists / lstat), NOT the target's listability — a transient EIO
      // on a LIVE mount (ours or a foreign identically-labeled drive) leaves the
      // source present and must never be torn down.
      const sourcePresent = source !== null ? await this.adapter.exists(source) : false;
      listing.push({ name, empty, mounted, source, sourcePresent });
      if (!mounted && !empty && contents !== null && matchesLabel(name, label)) {
        nonEmptyLeftovers.push(dirPath);
      }
    }

    const plan = reapPlan(listing, label);
    let dirs = 0;
    let mounts = 0;
    for (const name of plan.lazyUmounts) {
      const target = posix.join(base, name);
      const u = await this.adapter.exec(['umount', '-l', target]);
      if (u.code === 0) {
        mounts++;
        log(`reaped dead mount: umount -l ${target}`);
        this.activity('info', `reaped dead mount ${target}`);
      } else {
        log(`reap umount -l ${target} returned ${u.code}: ${u.stderr.trim()}`);
      }
    }
    for (const name of plan.rmdirs) {
      const target = posix.join(base, name);
      try {
        await this.adapter.removeDir(target);
        dirs++;
        log(`reaped leftover dir: rmdir ${target}`);
        this.activity('info', `reaped leftover directory ${target}`);
      } catch (e) {
        log(`reap rmdir ${target} skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // v0.2.1: a label-matched, unmounted, NON-empty leftover (e.g. an empty
    // mount-point skeleton blocking the clean name) -> scan its subtree. An
    // all-empty tree is cleared bottom-up via rmdir (counts as a reaped dir); a
    // subtree containing ANY file is LEFT untouched (the LEFTOVER_HAS_FILES
    // warning is surfaced by backingStatus).
    for (const dirPath of nonEmptyLeftovers) {
      const scan = await this.scanLeftover(dirPath);
      if (classifyLeftover(scan) === 'empty-tree') {
        if (await this.clearEmptyTree(dirPath, log)) {
          dirs++;
          log(`reaped empty leftover tree: ${dirPath}`);
          this.activity('info', `reaped empty leftover directory tree ${dirPath}`);
        }
      } else {
        log(`leftover ${dirPath} contains files — leaving untouched (review to reclaim the clean name)`);
      }
    }

    this.reaped = { dirs: this.reaped.dirs + dirs, mounts: this.reaped.mounts + mounts };
    return { dirs, mounts };
  }

  // --- sysfs replug (spec section 6 step 4, real-host only) ----------------

  /**
   * Synthesize a USB replug so umbreld's device-event automounter fires. ONLY
   * safe (and only called) when the device holds NO live mounts. Resolves the
   * USB device dir from /sys/block/<disk> and toggles its `authorized` attr
   * (0 then 1); falls back to a driver unbind/bind. Returns {ok, manual}.
   */
  async sysfsReplug(settings: Settings, log: LogSink): Promise<{ ok: boolean; manual: boolean }> {
    const device = await this.device(settings);
    if (device === null) {
      log('sysfs replug: device path unresolved — cannot locate /sys/block entry');
      return { ok: false, manual: true };
    }
    const disk = this.diskOf(device);
    if (disk === null) {
      log(`sysfs replug: could not derive a whole-disk name from ${device}`);
      return { ok: false, manual: true };
    }
    // F2 (physical safety): the toggle de-authorizes the ENTIRE disk. Before
    // touching `authorized`, veto if ANY partition of the disk still holds a live
    // mount — yanking power from a live sibling fs corrupts it. Fall back to a
    // manual unplug/replug (the user pulls the cable only when they choose to).
    const diskMounts = await this.diskLiveMounts(settings);
    if (diskMounts.length > 0) {
      log(
        `sysfs replug: disk ${disk} still holds ${diskMounts.length} live mount(s) ` +
          `(${diskMounts.join(', ')}); refusing to de-authorize the whole disk — a manual USB replug is required`,
      );
      this.activity('warn', `refused sysfs replug: disk ${disk} has live mount(s) (${diskMounts.join(', ')})`);
      return { ok: false, manual: true };
    }
    const blockLink = `/sys/block/${disk}`;
    const resolved = await this.adapter.realpath(blockLink);
    if (resolved === null) {
      log(`sysfs replug: ${blockLink} did not resolve`);
      return { ok: false, manual: true };
    }

    // Ascend to the nearest USB device dir (has both `authorized` and `idVendor`).
    const usbDir = await this.findUsbDeviceDir(resolved, log);
    if (usbDir === null) {
      log('sysfs replug: no USB device dir with an `authorized` attribute found in the ancestry');
      return { ok: false, manual: true };
    }

    const authFile = `${usbDir}/authorized`;
    if (await this.adapter.exists(authFile)) {
      const off = await this.adapter.exec(['sh', '-c', `echo 0 > ${shquote(authFile)}`]);
      const on = await this.adapter.exec(['sh', '-c', `echo 1 > ${shquote(authFile)}`]);
      if (off.code === 0 && on.code === 0) {
        log(`sysfs replug: toggled ${authFile} (0 -> 1)`);
        this.activity('info', 'synthesized a USB replug via sysfs authorized toggle');
        return { ok: true, manual: false };
      }
      log(`sysfs replug: authorized toggle failed (off ${off.code}, on ${on.code})`);
    }

    // Driver unbind/bind fallback (busid = basename of the USB device dir).
    const busid = posix.basename(usbDir);
    const driverLink = `${usbDir}/driver`;
    const driverDir = await this.adapter.realpath(driverLink);
    if (driverDir !== null) {
      const unbind = await this.adapter.exec(['sh', '-c', `echo ${shquote(busid)} > ${shquote(`${driverDir}/unbind`)}`]);
      const bind = await this.adapter.exec(['sh', '-c', `echo ${shquote(busid)} > ${shquote(`${driverDir}/bind`)}`]);
      if (unbind.code === 0 && bind.code === 0) {
        log(`sysfs replug: driver unbind/bind of ${busid} via ${driverDir}`);
        this.activity('info', 'synthesized a USB replug via driver unbind/bind');
        return { ok: true, manual: false };
      }
      log(`sysfs replug: driver unbind/bind failed (unbind ${unbind.code}, bind ${bind.code})`);
    }

    return { ok: false, manual: true };
  }

  /** /dev/sdb1 -> sdb ; /dev/nvme0n1p2 -> nvme0n1 ; /dev/mmcblk0p1 -> mmcblk0. */
  private diskOf(devicePath: string): string | null {
    const base = posix.basename(devicePath);
    if (base === '') return null;
    let m = base.match(/^([a-z]+)\d+$/); // sdb1 -> sdb
    if (m) return m[1]!;
    m = base.match(/^(nvme\d+n\d+)p\d+$/); // nvme0n1p2 -> nvme0n1
    if (m) return m[1]!;
    m = base.match(/^(mmcblk\d+)p\d+$/); // mmcblk0p1 -> mmcblk0
    if (m) return m[1]!;
    return base; // already a whole disk
  }

  /** Walk up from a resolved /sys path to the nearest USB *device* dir. */
  private async findUsbDeviceDir(startPath: string, log: LogSink): Promise<string | null> {
    let cur = startPath;
    for (let i = 0; i < 12; i++) {
      const hasAuth = await this.adapter.exists(`${cur}/authorized`);
      const hasVendor = await this.adapter.exists(`${cur}/idVendor`);
      if (hasAuth && hasVendor) return cur;
      const parent = posix.dirname(cur);
      if (parent === cur || parent === '/' || parent === '/sys' || parent === '.') break;
      cur = parent;
    }
    log('sysfs replug: reached the top of the /sys ancestry without a USB device dir');
    return null;
  }

  // --- reclaim / name-drift (spec §8, v0.2.1) ------------------------------

  /** True when `path`'s basename is `<label> (N)` — umbreld's drifted name. */
  private isDriftedBasename(path: string, label: string): boolean {
    const sanitized = sanitizeLabel(label);
    if (sanitized === '') return false;
    const base = posix.basename(path);
    return new RegExp(`^${escapeRegExp(sanitized)} \\(\\d+\\)$`).test(base);
  }

  /**
   * Compute the reclaim flags for an already-classified cooperative view: is the
   * bound umbrelMount on a drifted `<label> (N)` name, and is the clean name
   * reclaimable (no leftover, or an all-empty leftover tree)? Scans the clean-name
   * leftover ONLY when drifted (so the common healthy path adds no I/O). A leftover
   * that contains files is not reclaimable and yields its path (the warning's {path}).
   */
  private async computeDriftInfo(
    settings: Settings,
    view: BackingView,
    active: BackingStatus['active'],
  ): Promise<{ driftedName: boolean; cleanNameReclaimable: boolean; leftoverPath: string | null }> {
    const boundPath = view.umbrelMount.path;
    const driftedName =
      active === 'umbrel-bind' && boundPath !== null && this.isDriftedBasename(boundPath, this.reapLabel(settings));
    if (!driftedName) return { driftedName: false, cleanNameReclaimable: false, leftoverPath: null };

    const cleanPath = posix.join(externalBase(settings), sanitizeLabel(this.reapLabel(settings)));
    const type = await this.adapter.statType(cleanPath);
    if (type === null) return { driftedName: true, cleanNameReclaimable: true, leftoverPath: null }; // nothing blocking
    if (type !== 'dir') return { driftedName: true, cleanNameReclaimable: false, leftoverPath: cleanPath };
    const scan = await this.scanLeftover(cleanPath);
    if (classifyLeftover(scan) === 'empty-tree') {
      return { driftedName: true, cleanNameReclaimable: true, leftoverPath: null };
    }
    return { driftedName: true, cleanNameReclaimable: false, leftoverPath: cleanPath };
  }

  /**
   * Public reclaim probe for the switch runner: classify, derive the active
   * backing, then compute the drift/reclaim flags. Cheap in the common case
   * (only scans a subtree when actually drifted).
   */
  async driftInfo(
    settings: Settings,
  ): Promise<{ driftedName: boolean; cleanNameReclaimable: boolean; leftoverPath: string | null; umbrelMountPath: string | null }> {
    if ((settings.mountMode ?? 'classic') !== 'cooperative') {
      return { driftedName: false, cleanNameReclaimable: false, leftoverPath: null, umbrelMountPath: null };
    }
    const { view } = await this.classify(settings);
    let active: BackingStatus['active'] = 'none';
    if (view.stablePath.bindOfUmbrel && !view.stablePath.stale) active = 'umbrel-bind';
    else if (view.stablePath.direct && !view.stablePath.stale) active = 'direct';
    const d = await this.computeDriftInfo(settings, view, active);
    return { ...d, umbrelMountPath: view.umbrelMount.path };
  }

  // --- status (spec section 8) ---------------------------------------------

  /**
   * Build status.backing + the derived warnings. In classic mode this avoids
   * mountinfo entirely (derives `active` from the plain mount table); in
   * cooperative mode it classifies the mountinfo and probes umbrelMount readability.
   */
  async backingStatus(settings: Settings): Promise<{ backing: BackingStatus; warnings: WarningCode[] }> {
    const rec = this.store.get();
    const mode = settings.mountMode ?? 'classic';
    const warnings: WarningCode[] = [];

    if (mode !== 'cooperative') {
      // Classic: our direct mount blocks umbreld's automount -> Files shows Format.
      const mounts = await this.adapter.readProcMounts();
      const mounted = mounts.split('\n').some((l) => l.split(/\s+/)[1] === settings.mountPoint);
      const present = (await this.adapter.realpath(byUuidPath(settings))) !== null;
      const active = mounted ? 'direct' : 'none';
      if (present && mounted) warnings.push('FORMAT_DIALOG_EXPECTED');
      return {
        backing: {
          mode,
          active,
          umbrelMount: { found: false, path: null, readable: false },
          bindGeneration: rec.bindGeneration,
          lastBindChangeAt: rec.lastBindChangeAt,
          reaped: { ...this.reaped },
        },
        warnings,
      };
    }

    // Cooperative.
    const device = await this.device(settings);
    const drivePresent = device !== null;
    const entries = await this.mountInfo();
    const view = classifyBacking(entries, {
      device,
      mountPoint: settings.mountPoint,
      externalBase: externalBase(settings),
      record: rec,
      deviceMajMin: deviceMajMinOf(entries, device),
    });
    let readable = false;
    if (view.umbrelMount.found && view.umbrelMount.path !== null) {
      readable = (await this.adapter.listDir(view.umbrelMount.path)) !== null;
    }

    let active: BackingStatus['active'] = 'none';
    if (view.stablePath.bindOfUmbrel && !view.stablePath.stale) active = 'umbrel-bind';
    else if (view.stablePath.direct && !view.stablePath.stale) active = 'direct';

    const graceRemainingSec = this.graceRemainingSec(settings);

    // Warnings.
    if (drivePresent && !view.umbrelMount.found) {
      const ejected = rec.active === 'none' && rec.boundTo !== null;
      if (ejected || view.stablePath.bindOfUmbrel) warnings.push('EJECTED_IN_UMBREL');
      else if (graceRemainingSec > 0) warnings.push('WAITING_FOR_UMBREL_MOUNT');
    }
    if (active === 'direct') {
      // A cooperative-mode direct fallback also blocks umbreld -> Format dialog.
      warnings.push('FORMAT_DIALOG_EXPECTED');
    }

    // v0.2.1 reclaim flags: is umbreld drifted off the clean name, and can we
    // reclaim it? Surfaces LEFTOVER_HAS_FILES when the leftover contains files.
    const drift = await this.computeDriftInfo(settings, view, active);

    const backing: BackingStatus = {
      mode,
      active,
      umbrelMount: {
        found: view.umbrelMount.found,
        path: view.umbrelMount.path,
        readable,
      },
      bindGeneration: rec.bindGeneration,
      lastBindChangeAt: rec.lastBindChangeAt,
      reaped: { ...this.reaped },
      driftedName: drift.driftedName,
      cleanNameReclaimable: drift.cleanNameReclaimable,
    };
    if (drift.leftoverPath !== null) backing.leftoverPath = drift.leftoverPath;
    if (drift.driftedName && !drift.cleanNameReclaimable && drift.leftoverPath !== null) {
      warnings.push('LEFTOVER_HAS_FILES');
    }
    if (graceRemainingSec > 0) backing.graceRemainingSec = graceRemainingSec;
    return { backing, warnings };
  }

  /** For the migration job: reset drive-transition tracking so the switch restarts grace. */
  markHandoverStart(): void {
    this.startGrace(true);
  }

  /** Directly set the persisted mode (migration step 1). */
  setMode(mode: Settings['mountMode']): void {
    this.persist({ mode });
  }
}
