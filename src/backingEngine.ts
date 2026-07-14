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

import { backingDecide, classifyBacking, parseMountInfo } from './backing.js';
import type { EventLog } from './events.js';
import type { HostAdapter } from './hostAdapter.js';
import { byUuidPath, externalBase } from './paths.js';
import { probeLiveOk, recreatePlex } from './plex.js';
import { reapPlan, type ReapEntry } from './reap.js';
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

function nowIso(): string {
  return new Date().toISOString();
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
    const rec = this.store.get();
    if (force || rec.graceStartedAt === null) {
      this.persist({ graceStartedAt: nowIso() });
    }
  }

  private graceRemainingSec(settings: Settings): number {
    const rec = this.store.get();
    if (rec.graceStartedAt === null) return 0;
    const started = Date.parse(rec.graceStartedAt);
    if (!Number.isFinite(started)) return 0;
    const graceSec = settings.graceSec ?? 180;
    const elapsed = Math.floor((Date.now() - started) / 1000);
    return Math.max(0, graceSec - elapsed);
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

  async reap(settings: Settings, log: LogSink = NOOP_LOG): Promise<ReapCounts> {
    const base = externalBase(settings);
    const names = await this.adapter.listDir(base);
    if (names === null) return { dirs: 0, mounts: 0 };

    const entries = await this.mountInfo();
    const mountedAt = new Map<string, MountInfoEntry>();
    for (const e of entries) mountedAt.set(e.mountpoint, e);

    const label = posix.basename(settings.mountPoint);
    const listing: ReapEntry[] = [];
    for (const name of names.slice(0, REAP_SCAN_LIMIT)) {
      const dirPath = posix.join(base, name);
      const contents = await this.adapter.listDir(dirPath);
      const mounted = mountedAt.has(dirPath);
      // Dead = mounted but the target cannot be listed (source device gone / EIO).
      const dead = mounted && contents === null;
      const empty = contents !== null && contents.length === 0;
      listing.push({ name, empty, mounted, dead });
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
    };
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
