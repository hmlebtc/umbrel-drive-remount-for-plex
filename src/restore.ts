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
 *   - the Plex recreate prefers umbreld-native restart and falls back to
 *     `docker compose ... up -d --force-recreate` with APP_ID / APP_DATA_DIR /
 *     UMBREL_ROOT / DEVICE_HOSTNAME (hostname read live) passed as nsenter env.
 *
 * start() is synchronous single-flight (so POST /api/restore can 409 without
 * awaiting); the job itself runs asynchronously, deferred to a macrotask so a
 * second start() in the same tick reliably observes running:true.
 */

import { randomUUID } from 'node:crypto';

import { ensureHookBlock } from './bootHook.js';
import { ensureVolumeLine } from './composePatch.js';
import type { EventLog } from './events.js';
import type { HostAdapter } from './hostAdapter.js';
import { findMount, parseProcMounts } from './mounts.js';
import { appDataDir, byUuidPath, composePath, hookPath, hostMediaPath } from './paths.js';
import { isHealthy, probeStatus } from './status.js';
import type { AppStatus, JobStep, RestoreJob, RestoreTrigger, Settings, StepName } from './types.js';

const STEP_ORDER: StepName[] = ['preflight', 'bootHook', 'mount', 'composePatch', 'recreate', 'verify'];

export interface RestoreRunner {
  start(trigger: RestoreTrigger): { ok: true; jobId: string } | { ok: false; error: string };
  getJob(): RestoreJob | null;
  isRunning(): boolean;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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

class RestoreRunnerImpl implements RestoreRunner {
  private job: RestoreJob | null = null;

  constructor(
    private readonly adapter: HostAdapter,
    private readonly getSettings: () => Settings,
    private readonly events?: EventLog,
  ) {}

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
      if (trigger !== 'restart-plex' && isHealthy(status)) {
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
      });
      if (hookRes.changed) {
        await this.adapter.writeFileAtomic(hp, hookRes.text, 0o755);
        this.logLine(hook, `installed boot hook at ${hp}${hookRes.foreignContentPreserved ? ' (preserved existing content)' : ''}`);
        hook.state = 'ok';
      } else {
        this.logLine(hook, 'boot hook already current');
        hook.state = 'skipped';
      }

      // --- MOUNT ------------------------------------------------------------
      const mnt = this.stepOf(job, 'mount');
      mnt.state = 'running';
      const mounted = await this.ensureMount(mnt, settings);
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
      const bindPresent =
        inspect.found &&
        inspect.state === 'running' &&
        inspect.binds.some((b) => b.destination === settings.containerMediaPath);
      const needRecreate =
        trigger === 'restart-plex' ||
        composeChanged ||
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
      status = await probeStatus(this.adapter, settings);
      if (isHealthy(status)) {
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
    const stale = mounted && device !== null && entry!.source !== device;

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

  /** Recreate Plex: umbreld-native first, docker compose fallback. */
  private async recreatePlex(step: JobStep, settings: Settings): Promise<boolean> {
    const hostname = await this.adapter.hostname();
    const env: Record<string, string> = {
      APP_ID: settings.plexAppId,
      APP_DATA_DIR: appDataDir(settings),
      UMBREL_ROOT: settings.umbrelRoot,
      DEVICE_HOSTNAME: hostname,
    };

    const viaUmbreld = await this.adapter.exec([
      'umbreld-client',
      'apps.restart.mutate',
      `--appId=${settings.plexAppId}`,
    ]);
    if (viaUmbreld.code === 0) {
      this.logLine(step, 'recreated via umbreld-client');
      return true;
    }
    this.logLine(step, `umbreld-client unavailable (code ${viaUmbreld.code}); falling back to docker compose`);

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
}

export function createRestoreRunner(
  adapter: HostAdapter,
  getSettings: () => Settings,
  events?: EventLog,
): RestoreRunner {
  return new RestoreRunnerImpl(adapter, getSettings, events);
}
