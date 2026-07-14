/**
 * Restore job runner (spec section 7).
 *
 * A single-flight, six-step job: preflight -> bootHook -> mount -> composePatch
 * -> recreate -> verify. Each step records {name, state, log}. Semantics:
 *   - healthy system (full restore) is a no-op: every step is skipped, result
 *     is "already healthy",
 *   - a preflight failure (drive absent) fails the job; NO later step runs,
 *   - recreate is CONDITIONAL: it is skipped when the running Plex container
 *     already carries the media bind and nothing forced it; a "restart-plex"
 *     trigger always forces it,
 *   - the Plex recreate runs `docker compose ... up -d --force-recreate` with
 *     APP_ID / APP_DATA_DIR / UMBREL_ROOT / DEVICE_HOSTNAME (hostname read live)
 *     passed as nsenter env — no umbreld CLI exists on umbrelOS to try first.
 *
 * start() is synchronous single-flight (so POST /api/restore can 409 without
 * awaiting); the job itself runs asynchronously, deferred to a macrotask so a
 * second start() in the same tick reliably observes running:true.
 */

import { randomUUID } from 'node:crypto';

import type { BackingEngine } from './backingEngine.js';
import { backupFile } from './backups.js';
import { ensureHookBlock } from './bootHook.js';
import { ensureVolumeLine } from './composePatch.js';
import type { EventLog } from './events.js';
import type { HostAdapter } from './hostAdapter.js';
import { findMount, parseProcMounts } from './mounts.js';
import { appDataDir, byUuidPath, composePath, hookPath, hostMediaPath } from './paths.js';
import type { SettingsStore } from './settings.js';
import { computeStale, isHealthy, probeMountReadable, probeStatus } from './status.js';
import type {
  AppStatus,
  JobStep,
  MountMode,
  RestoreJob,
  RestoreTrigger,
  Settings,
  StepName,
} from './types.js';

const STEP_ORDER: StepName[] = ['preflight', 'bootHook', 'mount', 'composePatch', 'recreate', 'verify'];
const SWITCH_COOP_STEPS: StepName[] = [
  'set-mode',
  'reap',
  'unmount',
  'rescan',
  'wait-umbrel',
  'bind',
  'recreate',
  'verify',
];
const SWITCH_CLASSIC_STEPS: StepName[] = ['set-mode', 'unmount', 'mount', 'recreate', 'verify'];

/** Optional collaborators wired in production; omitted in classic-only unit tests. */
export interface RestoreExtras {
  /** Cooperative backing engine (enables the cooperative mount step + switch job). */
  backing?: BackingEngine;
  /** Settings store, required to persist mountMode during a switch. */
  settings?: SettingsStore;
  /** Called after a mode change so the caller can reschedule/re-render. */
  onModeChange?: () => void;
}

export interface RestoreRunner {
  start(trigger: RestoreTrigger): { ok: true; jobId: string } | { ok: false; error: string };
  /** Start a guided mode switch (spec section 6); shares the single-flight lock. */
  startSwitch(mode: MountMode): { ok: true; jobId: string } | { ok: false; error: string };
  getJob(): RestoreJob | null;
  isRunning(): boolean;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

function collectProblems(s: AppStatus): string {
  const p: string[] = [];
  if (!s.drive.present) p.push('drive absent');
  if (!s.mount.mounted) p.push('not mounted');
  else if (s.mount.stale) p.push('stale mount');
  if (!s.bootHook.ok) p.push('boot hook');
  if (!s.composePatch.ok) p.push('compose not patched');
  if (!s.plex.bindOk) p.push('Plex bind missing');
  if (!s.media.ok) p.push('media folders');
  return p.join(', ') || 'unknown';
}

/** Mode-aware "is the system in a good state" predicate used by the restore job. */
function restoreHealthy(s: AppStatus, settings: Settings): boolean {
  if ((settings.mountMode ?? 'classic') === 'cooperative') {
    // A cooperative restore's goal is a WORKING Plex (bind OR direct fallback),
    // not strictly the umbrel-bind — the monitor hands over to umbrelOS later.
    return (
      s.mount.mounted &&
      !s.mount.stale &&
      s.plex.bindOk &&
      s.bootHook.ok &&
      s.composePatch.ok &&
      s.media.ok &&
      s.plex.liveOk !== false
    );
  }
  return isHealthy(s);
}

class RestoreRunnerImpl implements RestoreRunner {
  private job: RestoreJob | null = null;
  private readonly backing?: BackingEngine;
  private readonly settingsStore?: SettingsStore;
  private readonly onModeChange?: () => void;

  constructor(
    private readonly adapter: HostAdapter,
    private readonly getSettings: () => Settings,
    private readonly events?: EventLog,
    private readonly dataDir?: string,
    extras?: RestoreExtras,
  ) {
    this.backing = extras?.backing;
    this.settingsStore = extras?.settings;
    this.onModeChange = extras?.onModeChange;
  }

  /**
   * Snapshot a host file's CURRENT content to ${dataDir}/backups before we
   * overwrite it, and log the backup path into the step. No-op (no backup) when
   * no data dir is configured or the file did not previously exist.
   */
  private backup(step: JobStep, sourcePath: string, currentContent: string | null): void {
    if (this.dataDir === undefined) return;
    const path = backupFile(this.dataDir, sourcePath, currentContent);
    if (path !== null) this.logLine(step, `backed up previous ${sourcePath} to ${path}`);
  }

  /** probeStatus enriched with the engine's authoritative backing when available. */
  private async probeWithBacking(settings: Settings): Promise<AppStatus> {
    if (this.backing && (settings.mountMode ?? 'classic') === 'cooperative') {
      return probeStatus(this.adapter, settings, { backing: await this.backing.backingStatus(settings) });
    }
    return probeStatus(this.adapter, settings);
  }

  isRunning(): boolean {
    return this.job?.running === true;
  }

  getJob(): RestoreJob | null {
    return this.job;
  }

  start(trigger: RestoreTrigger): { ok: true; jobId: string } | { ok: false; error: string } {
    if (this.job?.running) {
      return { ok: false, error: 'a restore job is already running' };
    }
    const jobId = randomUUID();
    const steps: JobStep[] = STEP_ORDER.map((name) => ({ name, state: 'pending', log: [] }));
    const job: RestoreJob = {
      running: true,
      jobId,
      trigger,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      steps,
      result: null,
    };
    this.job = job;
    this.events?.info('restore', `restore started (trigger: ${trigger})`);
    // Defer to a macrotask so a synchronous second start() sees running:true.
    setImmediate(() => {
      void this.execute(trigger, job);
    });
    return { ok: true, jobId };
  }

  startSwitch(mode: MountMode): { ok: true; jobId: string } | { ok: false; error: string } {
    if (this.job?.running) {
      return { ok: false, error: 'a job is already running' };
    }
    if (!this.backing) {
      return { ok: false, error: 'cooperative backing engine is not available' };
    }
    if (!this.settingsStore) {
      return { ok: false, error: 'settings store is not available' };
    }
    const jobId = randomUUID();
    const trigger: RestoreTrigger = mode === 'cooperative' ? 'switch-cooperative' : 'switch-classic';
    const order = mode === 'cooperative' ? SWITCH_COOP_STEPS : SWITCH_CLASSIC_STEPS;
    const steps: JobStep[] = order.map((name) => ({ name, state: 'pending', log: [] }));
    const job: RestoreJob = {
      running: true,
      jobId,
      trigger,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      steps,
      result: null,
    };
    this.job = job;
    this.events?.info('switch', `switch to ${mode} mode started`);
    setImmediate(() => {
      void this.executeSwitch(mode, job);
    });
    return { ok: true, jobId };
  }

  private stepOf(job: RestoreJob, name: StepName): JobStep {
    return job.steps.find((s) => s.name === name)!;
  }

  private logLine(step: JobStep, line: string): void {
    step.log.push({ ts: new Date().toISOString(), line });
  }

  private finish(job: RestoreJob, result: string, ok: boolean): void {
    job.result = result;
    job.finishedAt = new Date().toISOString();
    job.running = false;
    if (this.events) {
      if (ok) this.events.info('restore', result);
      else this.events.error('restore', result);
    }
  }

  private async execute(trigger: RestoreTrigger, job: RestoreJob): Promise<void> {
    const settings = this.getSettings();
    try {
      // --- PREFLIGHT --------------------------------------------------------
      const pre = this.stepOf(job, 'preflight');
      pre.state = 'running';
      let status = await probeStatus(this.adapter, settings);
      if (!status.drive.present) {
        this.logLine(pre, `external drive (uuid ${settings.uuid || 'unset'}) is not attached`);
        pre.state = 'failed';
        this.finish(job, 'Restore failed: external drive not present — attach the drive and retry', false);
        return;
      }
      this.logLine(pre, `drive present at ${status.drive.device ?? 'unknown device'}`);
      pre.state = 'ok';

      // Healthy no-op for a full restore (a restart-plex always proceeds).
      if (trigger !== 'restart-plex' && restoreHealthy(status, settings)) {
        for (const name of ['bootHook', 'mount', 'composePatch', 'recreate', 'verify'] as StepName[]) {
          const s = this.stepOf(job, name);
          this.logLine(s, 'already healthy — nothing to do');
          s.state = 'skipped';
        }
        this.finish(job, 'System already healthy — no changes needed', true);
        return;
      }

      // --- BOOT HOOK --------------------------------------------------------
      const hook = this.stepOf(job, 'bootHook');
      hook.state = 'running';
      const hp = hookPath(settings);
      const existingHook = await this.adapter.readFile(hp);
      const hookRes = ensureHookBlock(existingHook, {
        uuid: settings.uuid,
        mountPoint: settings.mountPoint,
        fsType: settings.fsType,
        mountMode: settings.mountMode ?? 'classic',
      });
      if (hookRes.changed) {
        this.backup(hook, hp, existingHook);
        await this.adapter.writeFileAtomic(hp, hookRes.text, 0o755);
        this.logLine(hook, `installed boot hook at ${hp}${hookRes.foreignContentPreserved ? ' (preserved existing content)' : ''}`);
        hook.state = 'ok';
      } else {
        this.logLine(hook, 'boot hook already current');
        hook.state = 'skipped';
      }

      // --- MOUNT (mode-aware: cooperative uses the backing ladder) -----------
      const mnt = this.stepOf(job, 'mount');
      mnt.state = 'running';
      const cooperative = (settings.mountMode ?? 'classic') === 'cooperative' && this.backing !== undefined;
      // A cooperative (re)bind/mount changes the backing under a possibly-running
      // Plex: force a recreate (the compose path is unchanged, so bindPresent
      // below would otherwise wrongly skip it — the bind-generation problem).
      let backingChanged = false;
      let mounted: boolean;
      if (cooperative) {
        const r = await this.ensureBackingCooperative(mnt, settings);
        mounted = r.ok;
        backingChanged = r.changed;
      } else {
        mounted = await this.ensureMount(mnt, settings);
      }
      if (!mounted) {
        mnt.state = 'failed';
        this.finish(job, 'Restore failed: the drive could not be mounted', false);
        return;
      }

      // --- COMPOSE PATCH ----------------------------------------------------
      const patch = this.stepOf(job, 'composePatch');
      patch.state = 'running';
      let composeChanged = false;
      const cp = composePath(settings);
      const composeText = await this.adapter.readFile(cp);
      if (composeText === null) {
        this.logLine(patch, `Plex compose file not found at ${cp}`);
        patch.state = 'failed';
        this.finish(job, 'Restore failed: Plex compose file not found (is the Plex app installed?)', false);
        return;
      }
      const patchRes = ensureVolumeLine(composeText, {
        hostPath: hostMediaPath(settings),
        containerPath: settings.containerMediaPath,
      });
      if (patchRes.problems.length > 0) {
        for (const p of patchRes.problems) this.logLine(patch, p);
        patch.state = 'failed';
        this.finish(job, `Restore failed: cannot patch Plex compose (${patchRes.problems.join('; ')})`, false);
        return;
      }
      if (patchRes.changed) {
        this.backup(patch, cp, composeText);
        await this.adapter.writeFileAtomic(cp, patchRes.text);
        composeChanged = true;
        this.logLine(patch, `patched media bind into ${cp}`);
        patch.state = 'ok';
      } else {
        this.logLine(patch, 'compose already patched');
        patch.state = 'skipped';
      }

      // --- RECREATE (conditional) ------------------------------------------
      const rec = this.stepOf(job, 'recreate');
      rec.state = 'running';
      const inspect = await this.adapter.inspectPlex(settings.plexAppId);
      const wantSource = hostMediaPath(settings);
      const bindPresent =
        inspect.found &&
        inspect.state === 'running' &&
        inspect.binds.some(
          (b) => b.source === wantSource && b.destination === settings.containerMediaPath,
        );
      const needRecreate =
        trigger === 'restart-plex' ||
        composeChanged ||
        backingChanged ||
        !inspect.found ||
        inspect.state !== 'running' ||
        !bindPresent;
      if (!needRecreate) {
        this.logLine(rec, 'running Plex container already has the media bind — skipping recreate');
        rec.state = 'skipped';
      } else {
        const reason =
          trigger === 'restart-plex'
            ? 'manual Plex restart requested'
            : composeChanged
              ? 'compose was just patched'
              : backingChanged
                ? 'the cooperative backing was just (re)bound'
                : !inspect.found
                ? 'Plex container not found'
                : inspect.state !== 'running'
                  ? `Plex container not running (${inspect.state ?? 'unknown'})`
                  : 'running container is missing the media bind';
        this.logLine(rec, `recreating Plex: ${reason}`);
        const recreated = await this.recreatePlex(rec, settings);
        if (!recreated) {
          rec.state = 'failed';
          this.finish(job, 'Restore failed: could not recreate the Plex container', false);
          return;
        }
        rec.state = 'ok';
      }

      // --- VERIFY -----------------------------------------------------------
      const ver = this.stepOf(job, 'verify');
      ver.state = 'running';
      status = await this.probeWithBacking(settings);
      if (restoreHealthy(status, settings)) {
        this.logLine(ver, 'verified: media mount is healthy');
        ver.state = 'ok';
        this.finish(job, 'Restore complete — Plex media mount is healthy', true);
      } else {
        const problems = collectProblems(status);
        this.logLine(ver, `still unhealthy: ${problems}`);
        ver.state = 'failed';
        this.finish(job, `Restore ran but the system is still unhealthy: ${problems}`, false);
      }
    } catch (e) {
      // Any unexpected throw: fail the currently-running step and the job.
      for (const s of job.steps) {
        if (s.state === 'running') {
          this.logLine(s, errMsg(e));
          s.state = 'failed';
        }
      }
      if (job.running) this.finish(job, `Restore failed: ${errMsg(e)}`, false);
    } finally {
      // Never leave a step or the job dangling in a running state.
      for (const s of job.steps) {
        if (s.state === 'running') s.state = 'failed';
      }
      if (job.running) {
        job.running = false;
        job.finishedAt = new Date().toISOString();
        if (job.result === null) job.result = 'Restore ended unexpectedly';
      }
    }
  }

  /** Ensure the drive is mounted (remount if stale). Sets step state; returns success. */
  private async ensureMount(step: JobStep, settings: Settings): Promise<boolean> {
    const dev = byUuidPath(settings);
    const device = await this.adapter.realpath(dev);
    const entry = findMount(parseProcMounts(await this.adapter.readProcMounts()), settings.mountPoint);
    const mounted = entry !== null;
    // Stale detection uses the SAME helper + EIO probe as status.ts so both
    // agree: stale when the by-uuid device is gone, the target is unreadable
    // (EIO), or the backing device no longer matches the live one.
    const targetReadable = mounted ? await probeMountReadable(this.adapter, settings.mountPoint) : true;
    const stale = computeStale(mounted, device !== null, device, entry?.source ?? '', targetReadable);

    if (mounted && !stale) {
      this.logLine(step, `already mounted at ${settings.mountPoint} (${entry!.source})`);
      step.state = 'skipped';
      return true;
    }

    if (mounted && stale) {
      this.logLine(step, `stale mount (mounted ${entry!.source}, drive now ${device ?? '?'}); unmounting`);
      const u = await this.adapter.exec(['umount', '-l', settings.mountPoint]);
      if (u.code !== 0) this.logLine(step, `umount -l returned ${u.code}: ${u.stderr.trim()}`);
    }

    await this.adapter.exec(['mkdir', '-p', settings.mountPoint]);
    const m = await this.adapter.exec(['mount', '-t', settings.fsType, dev, settings.mountPoint]);
    if (m.code !== 0) {
      this.logLine(step, `mount failed (code ${m.code}): ${m.stderr.trim()}`);
      return false;
    }

    const after = findMount(parseProcMounts(await this.adapter.readProcMounts()), settings.mountPoint);
    if (after === null) {
      this.logLine(step, 'mount command reported success but the mount is not present');
      return false;
    }
    this.logLine(step, `mounted ${dev} at ${settings.mountPoint}`);
    step.state = 'ok';
    return true;
  }

  /**
   * Recreate Plex via the user's proven direct `docker compose` invocation.
   * Neither `umbreld client` nor `umbreld-client` exists on umbrelOS (on the real
   * box they exit 1 / 127), so the compose recreate — `docker compose -f <compose>
   * up -d --force-recreate --no-deps server` with APP_ID / APP_DATA_DIR /
   * UMBREL_ROOT / DEVICE_HOSTNAME (hostname read live) passed as nsenter env — is
   * the SINGLE recreate path.
   */
  private async recreatePlex(step: JobStep, settings: Settings): Promise<boolean> {
    const hostname = await this.adapter.hostname();
    const env: Record<string, string> = {
      APP_ID: settings.plexAppId,
      APP_DATA_DIR: appDataDir(settings),
      UMBREL_ROOT: settings.umbrelRoot,
      DEVICE_HOSTNAME: hostname,
    };

    const compose = await this.adapter.exec(
      ['docker', 'compose', '-p', settings.plexAppId, '-f', composePath(settings), 'up', '-d', '--force-recreate', '--no-deps', 'server'],
      { env },
    );
    if (compose.code === 0) {
      this.logLine(step, 'recreated via docker compose');
      return true;
    }
    this.logLine(step, `docker compose failed (code ${compose.code}): ${compose.stderr.trim()}`);
    return false;
  }

  // -------------------------------------------------------------------------
  // Cooperative mount step (spec section 3) — the backing ladder replaces the
  // classic single mount step. Goal: leave Plex working NOW.
  // -------------------------------------------------------------------------

  private async ensureBackingCooperative(
    step: JobStep,
    settings: Settings,
  ): Promise<{ ok: boolean; changed: boolean }> {
    const backing = this.backing!;
    const log = (line: string): void => this.logLine(step, line);
    const { view } = await backing.classify(settings);
    const rec = backing.getRecord();

    if (view.umbrelMount.found && view.umbrelMount.path !== null) {
      if (
        view.stablePath.bindOfUmbrel &&
        !view.stablePath.stale &&
        rec.boundTo === view.umbrelMount.path
      ) {
        this.logLine(step, `already bound to the live umbrelOS mount at ${view.umbrelMount.path}`);
        step.state = 'skipped';
        return { ok: true, changed: false };
      }
      await backing.reap(settings, log);
      const ok = await backing.doBind(view.umbrelMount.path, view, settings, log);
      step.state = ok ? 'ok' : 'failed';
      return { ok, changed: ok };
    }

    // No usable umbrelOS mount — a direct fallback keeps Plex working; the
    // monitor hands over to umbrelOS later (ladder D).
    if (view.stablePath.direct && !view.stablePath.stale) {
      this.logLine(step, 'no umbrelOS mount available; already serving via the classic direct fallback');
      step.state = 'skipped';
      return { ok: true, changed: false };
    }
    const ok = await backing.doDirectMount(view, settings, log);
    step.state = ok ? 'ok' : 'failed';
    return { ok, changed: ok };
  }

  // -------------------------------------------------------------------------
  // Guided mode switch (spec section 6). Shares this.job's single-flight lock.
  // -------------------------------------------------------------------------

  private async executeSwitch(mode: MountMode, job: RestoreJob): Promise<void> {
    try {
      if (mode === 'cooperative') await this.switchToCooperative(job);
      else await this.switchToClassic(job);
    } catch (e) {
      for (const s of job.steps) {
        if (s.state === 'running') {
          this.logLine(s, errMsg(e));
          s.state = 'failed';
        }
      }
      if (job.running) this.finish(job, `Switch failed: ${errMsg(e)}`, false);
    } finally {
      for (const s of job.steps) {
        if (s.state === 'running') s.state = 'failed';
      }
      if (job.running) {
        job.running = false;
        job.finishedAt = new Date().toISOString();
        if (job.result === null) job.result = 'Switch ended unexpectedly';
      }
    }
  }

  private beginStep(job: RestoreJob, name: StepName): JobStep {
    const step = this.stepOf(job, name);
    step.state = 'running';
    return step;
  }

  /** Poll (bounded) for a readable umbrelOS mount to appear; returns its path or null. */
  private async waitForUmbrelMount(settings: Settings, graceMs: number): Promise<string | null> {
    const deadline = Date.now() + graceMs;
    for (;;) {
      const { view } = await this.backing!.classify(settings);
      if (view.umbrelMount.found && view.umbrelMount.path !== null) return view.umbrelMount.path;
      if (Date.now() >= deadline) return null;
      await delay(1000);
    }
  }

  private async switchToCooperative(job: RestoreJob): Promise<void> {
    const backing = this.backing!;
    const store = this.settingsStore!;

    // --- step 1: set-mode (preconditions + persist + hook re-render) --------
    const setMode = this.beginStep(job, 'set-mode');
    let settings = this.getSettings();
    let status = await this.probeWithBacking(settings);
    if (!status.drive.present) {
      this.logLine(setMode, 'external drive is not attached');
      setMode.state = 'failed';
      this.finish(job, 'Switch failed: attach the external drive first', false);
      return;
    }
    if (!status.plex.found) {
      this.logLine(setMode, 'Plex app/container not found');
      setMode.state = 'failed';
      this.finish(job, 'Switch failed: the Plex app was not found (install Plex first)', false);
      return;
    }
    const upd = store.update({ mountMode: 'cooperative' });
    if (!upd.ok) {
      this.logLine(setMode, `could not persist mountMode: ${upd.errors.join('; ')}`);
      setMode.state = 'failed';
      this.finish(job, 'Switch failed: could not persist the new mode', false);
      return;
    }
    backing.setMode('cooperative');
    settings = this.getSettings();
    this.onModeChange?.();
    // Re-render the boot hook to the cooperative (mkdir-only) block so a reboot
    // mid-switch never mounts the raw device and blocks umbreld.
    const hp = hookPath(settings);
    const existingHook = await this.adapter.readFile(hp);
    const hookRes = ensureHookBlock(existingHook, {
      uuid: settings.uuid,
      mountPoint: settings.mountPoint,
      fsType: settings.fsType,
      mountMode: 'cooperative',
    });
    if (hookRes.changed) {
      this.backup(setMode, hp, existingHook);
      await this.adapter.writeFileAtomic(hp, hookRes.text, 0o755);
      this.logLine(setMode, 'boot hook re-rendered to cooperative (mkdir-only)');
    }
    this.logLine(setMode, 'mountMode set to cooperative');
    setMode.state = 'ok';

    // Everything past here is reversible; any failure reverts to a direct mount.
    try {
      // --- step 2: reap ----------------------------------------------------
      const reap = this.beginStep(job, 'reap');
      const reaped = await backing.reap(settings, (l) => this.logLine(reap, l));
      this.logLine(reap, `reaped ${reaped.dirs} leftover dir(s), ${reaped.mounts} dead mount(s)`);
      reap.state = 'ok';

      // --- step 3: unmount OUR stable-path mount (section-10 rail: we only
      // ever umount /mnt/wdexternal here — never an arbitrary device mount) ---
      const unmount = this.beginStep(job, 'unmount');
      await backing.lazyUmount(settings.mountPoint, (l) => this.logLine(unmount, l));
      const live = await backing.deviceLiveMounts(settings);
      this.logLine(unmount, `device now holds ${live.length} live mount(s) after unmounting ${settings.mountPoint}`);
      unmount.state = 'ok';

      // --- step 4: rescan (synthesize a USB replug) — ONLY when the device
      // holds ZERO live mounts (section 10). If a propagated/other mount of the
      // device lingers, we do NOT force-umount it; we fall back to a manual replug.
      const rescan = this.beginStep(job, 'rescan');
      let replugManual = false;
      if (live.length > 0) {
        this.logLine(
          rescan,
          `device still holds ${live.length} live mount(s) (${live.join(', ')}) — skipping the sysfs replug (unsafe); a manual USB replug is required`,
        );
        replugManual = true;
      } else {
        const r = await backing.sysfsReplug(settings, (l) => this.logLine(rescan, l));
        replugManual = !r.ok;
        if (r.ok) this.logLine(rescan, 'synthesized a USB replug so umbreld re-scans');
        else this.logLine(rescan, 'sysfs replug unavailable — the user must unplug/replug the USB cable');
      }
      rescan.state = 'ok';

      // --- step 5: wait for umbreld to mount -------------------------------
      const wait = this.beginStep(job, 'wait-umbrel');
      backing.markHandoverStart();
      const graceMs = Math.max(1, settings.graceSec ?? 180) * 1000;
      const umbrelPath = await this.waitForUmbrelMount(settings, graceMs);
      if (umbrelPath === null) {
        if (replugManual) {
          // Documented fallback: leave cooperative + backing none, instruct a
          // manual replug; the monitor finishes via ladder A when it appears.
          this.logLine(wait, 'umbrelOS has not mounted the drive yet');
          wait.state = 'ok';
          for (const name of ['bind', 'recreate'] as StepName[]) {
            const s = this.stepOf(job, name);
            this.logLine(s, 'deferred — waiting for the manual USB replug');
            s.state = 'skipped';
          }
          const ver = this.beginStep(job, 'verify');
          this.logLine(ver, 'switch pending: unplug and replug the USB cable; the monitor will bind + restart Plex automatically');
          ver.state = 'ok';
          this.finish(
            job,
            'Switched to cooperative mode. umbrelOS has not mounted the drive yet — unplug and replug the USB cable; the app will finish binding and restart Plex automatically.',
            true,
          );
          return;
        }
        throw new Error('umbrelOS did not mount the drive within the grace window');
      }
      this.logLine(wait, `umbrelOS mounted the drive at ${umbrelPath}`);
      wait.state = 'ok';

      // --- step 6: bind ----------------------------------------------------
      const bind = this.beginStep(job, 'bind');
      const { view } = await backing.classify(settings);
      const bound = await backing.doBind(umbrelPath, view, settings, (l) => this.logLine(bind, l));
      if (!bound) throw new Error('failed to bind the stable path to the umbrelOS mount');
      bind.state = 'ok';

      // --- step 7: recreate Plex ------------------------------------------
      const rec = this.beginStep(job, 'recreate');
      const recreated = await backing.recreate(settings, (l) => this.logLine(rec, l));
      if (!recreated) throw new Error('failed to recreate the Plex container');
      rec.state = 'ok';

      // --- step 8: verify healthy AND umbreld-visible ----------------------
      const ver = this.beginStep(job, 'verify');
      status = await this.probeWithBacking(settings);
      const umbrelVisible = status.backing.umbrelMount.found;
      if (restoreHealthy(status, settings) && status.backing.active === 'umbrel-bind' && umbrelVisible) {
        this.logLine(ver, 'verified: cooperative bind active and umbrelOS-visible; Plex media is healthy');
        ver.state = 'ok';
        this.finish(job, 'Switched to cooperative mode — one drive now serves both umbrelOS Files and Plex.', true);
      } else {
        throw new Error(`post-switch verification failed: ${collectProblems(status)}`);
      }
    } catch (e) {
      await this.revertToDirect(job, errMsg(e));
    }
  }

  /**
   * Automatic revert (spec section 6): on ANY failure of the risky steps, mount
   * the drive directly by UUID so Plex is never left dark. mountMode stays
   * cooperative but the active backing becomes "direct" with a clear note.
   */
  private async revertToDirect(job: RestoreJob, reason: string): Promise<void> {
    const backing = this.backing!;
    const settings = this.getSettings();
    // Fail whatever step was mid-flight, and log the revert on it.
    const running = job.steps.find((s) => s.state === 'running') ?? this.stepOf(job, 'verify');
    this.logLine(running, `switch failed (${reason}); reverting to a direct mount so Plex keeps working`);
    running.state = 'failed';
    this.events?.warn('switch', `reverting to direct mount: ${reason}`);
    try {
      const { view } = await backing.classify(settings);
      const ok = await backing.doDirectMount(view, settings, (l) => this.logLine(running, l));
      if (ok) await backing.recreate(settings, (l) => this.logLine(running, l));
    } catch (e) {
      this.logLine(running, `revert direct-mount also failed: ${errMsg(e)}`);
    }
    this.finish(
      job,
      `Switch to cooperative failed (${reason}). Reverted to a direct mount so Plex keeps working (backing is now "direct"). ` +
        'umbrelOS Files may show a Format prompt — do NOT format; your data is intact. Retry the switch when ready.',
      false,
    );
  }

  private async switchToClassic(job: RestoreJob): Promise<void> {
    const backing = this.backing!;
    const store = this.settingsStore!;

    // --- step 1: set-mode (persist + hook re-render) -----------------------
    const setMode = this.beginStep(job, 'set-mode');
    let settings = this.getSettings();
    const status = await this.probeWithBacking(settings);
    if (!status.drive.present) {
      this.logLine(setMode, 'external drive is not attached');
      setMode.state = 'failed';
      this.finish(job, 'Switch failed: attach the external drive first', false);
      return;
    }
    const upd = store.update({ mountMode: 'classic' });
    if (!upd.ok) {
      this.logLine(setMode, `could not persist mountMode: ${upd.errors.join('; ')}`);
      setMode.state = 'failed';
      this.finish(job, 'Switch failed: could not persist the new mode', false);
      return;
    }
    backing.setMode('classic');
    settings = this.getSettings();
    this.onModeChange?.();
    const hp = hookPath(settings);
    const existingHook = await this.adapter.readFile(hp);
    const hookRes = ensureHookBlock(existingHook, {
      uuid: settings.uuid,
      mountPoint: settings.mountPoint,
      fsType: settings.fsType,
      mountMode: 'classic',
    });
    if (hookRes.changed) {
      this.backup(setMode, hp, existingHook);
      await this.adapter.writeFileAtomic(hp, hookRes.text, 0o755);
      this.logLine(setMode, 'boot hook re-rendered to classic (wait + mount by UUID)');
    }
    this.logLine(setMode, 'mountMode set to classic');
    setMode.state = 'ok';

    // --- step 2: unmount our bind -----------------------------------------
    const unmount = this.beginStep(job, 'unmount');
    const { view } = await backing.classify(settings);
    if (view.stablePath.mounted) {
      await backing.lazyUmount(settings.mountPoint, (l) => this.logLine(unmount, l));
    } else {
      this.logLine(unmount, 'stable path not mounted; nothing to unmount');
    }
    unmount.state = 'ok';

    // --- step 3: direct mount by UUID -------------------------------------
    const mount = this.beginStep(job, 'mount');
    const view2 = (await backing.classify(settings)).view;
    const mounted = await backing.doDirectMount(view2, settings, (l) => this.logLine(mount, l));
    if (!mounted) {
      mount.state = 'failed';
      this.finish(job, 'Switch to classic failed: the drive could not be direct-mounted', false);
      return;
    }
    mount.state = 'ok';

    // --- step 4: recreate Plex --------------------------------------------
    const rec = this.beginStep(job, 'recreate');
    const recreated = await backing.recreate(settings, (l) => this.logLine(rec, l));
    rec.state = recreated ? 'ok' : 'failed';

    // --- step 5: verify ----------------------------------------------------
    const ver = this.beginStep(job, 'verify');
    const finalStatus = await this.probeWithBacking(settings);
    if (restoreHealthy(finalStatus, settings)) {
      this.logLine(ver, 'verified: direct mount healthy. Note: umbrelOS Files will show a Format prompt — do NOT format; data is intact.');
      ver.state = 'ok';
      this.finish(
        job,
        'Switched to classic mode (direct mount). umbrelOS Files will show a Format prompt for this drive — do NOT format; your data is intact.',
        true,
      );
    } else {
      this.logLine(ver, `still unhealthy after switch: ${collectProblems(finalStatus)}`);
      ver.state = 'failed';
      this.finish(job, `Switch to classic ran but the system is still unhealthy: ${collectProblems(finalStatus)}`, false);
    }
  }
}

export function createRestoreRunner(
  adapter: HostAdapter,
  getSettings: () => Settings,
  events?: EventLog,
  dataDir?: string,
  extras?: RestoreExtras,
): RestoreRunner {
  return new RestoreRunnerImpl(adapter, getSettings, events, dataDir, extras);
}
