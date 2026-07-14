/**
 * Background monitor + pure decision function (spec section 8).
 *
 * decide() is a PURE function of (status, settings, history) — it never touches
 * the host or mutates anything — so the entire decision table is unit-testable.
 * The guard order is exactly:
 *   1. a restore job is running                         -> none
 *   2. suspended (unless a drive-reconnect transition)  -> none
 *   3. drive absent                                     -> none
 *   4. Plex container not found                         -> alert
 *   5. healthy                                          -> none
 *   6. broken but under requireConsecutiveBroken        -> none (debounce)
 *   7. within cooldownSec of the last restore attempt   -> none
 *   8. otherwise                                        -> restore
 *
 * The Monitor class owns the side effects (counter bookkeeping, firing the
 * restore, suspension after repeated failures) and schedules itself with an
 * unref()'d timer so it never keeps the process alive on shutdown.
 */

import type { BackingEngine } from './backingEngine.js';
import { plexNeedsRecreate } from './backingEngine.js';
import type { EventLog } from './events.js';
import type { HostAdapter } from './hostAdapter.js';
import { isHealthy, probeStatus } from './status.js';
import type {
  AppStatus,
  AutoHealStatus,
  Decision,
  MonitorHistory,
  Settings,
  RestoreJob,
} from './types.js';
import type { RestoreRunner } from './restore.js';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

/**
 * Pure decision function (spec section 8). Reads the carried history; does not
 * mutate it (the Monitor loop is responsible for advancing counters).
 */
export function decide(status: AppStatus, settings: Settings, history: MonitorHistory): Decision {
  const ah = settings.autoHeal;

  if (!ah.enabled) {
    return { action: 'none', reason: 'auto-heal is disabled' };
  }

  // 1. A restore job in flight always short-circuits.
  if (history.jobRunning) {
    return { action: 'none', reason: 'a restore job is currently running' };
  }

  // 2. Suspended — unless the drive just transitioned absent -> present.
  const reconnected = history.drivePresentPrev === false && status.drive.present === true;
  if (history.suspended && !reconnected) {
    return { action: 'none', reason: 'auto-heal is suspended after repeated failures' };
  }

  // 3. No drive -> nothing to heal (takes priority over a missing container).
  if (!status.drive.present) {
    return { action: 'none', reason: 'external drive is not attached' };
  }

  // 4. Drive present but Plex container missing -> alert only, never auto-act.
  if (!status.plex.found) {
    return { action: 'alert', reason: 'Plex container not found' };
  }

  // 5. Healthy.
  if (isHealthy(status)) {
    return { action: 'none', reason: 'system is healthy' };
  }

  // 6. Debounce: require N consecutive broken observations first.
  if (history.consecutiveBroken < ah.requireConsecutiveBroken) {
    return {
      action: 'none',
      reason: `debouncing (${history.consecutiveBroken}/${ah.requireConsecutiveBroken} broken checks)`,
    };
  }

  // 7. Cooldown: measured from the last restore ATTEMPT timestamp.
  if (history.lastRestoreAt !== null) {
    const elapsed = Date.parse(status.timestamp) - Date.parse(history.lastRestoreAt);
    if (Number.isFinite(elapsed) && elapsed < ah.cooldownSec * 1000) {
      return {
        action: 'none',
        reason: `within cooldown window (${Math.round(elapsed / 1000)}s < ${ah.cooldownSec}s)`,
      };
    }
  }

  // 8. Heal.
  return { action: 'restore', reason: 'system unhealthy — auto-heal triggered' };
}

/** Failure/suspension counters the monitor advances after an auto-heal restore. */
export interface RestoreBookkeeping {
  consecutiveFailures: number;
  consecutiveBroken: number;
  suspended: boolean;
  jobRunning: boolean;
}

/**
 * Compute the counter bookkeeping AFTER an auto-heal restore has been waited on.
 *
 * CRITICAL (spec section 8): only a job that ACTUALLY FINISHED updates the
 * success/failure counters. A job still running at the wait deadline
 * (isRunning() true, or finishedAt not yet set) must update NOTHING except to
 * keep jobRunning:true — otherwise a slow restore whose steps are still
 * "pending" (no failed step) would be mis-booked as a success, reset the
 * failure counter, and let a genuinely-failing slow restore evade suspension.
 */
export function bookRestoreOutcome(
  prev: RestoreBookkeeping,
  opts: { isRunning: boolean; job: RestoreJob | null; maxConsecutiveFailures: number },
): RestoreBookkeeping {
  const finished = !opts.isRunning && opts.job !== null && opts.job.finishedAt != null;
  if (!finished) {
    // Still running at the deadline: change nothing, keep guarding.
    return { ...prev, jobRunning: true };
  }
  const failed = opts.job!.steps.some((s) => s.state === 'failed');
  if (!failed) {
    return { consecutiveFailures: 0, consecutiveBroken: 0, suspended: false, jobRunning: false };
  }
  const consecutiveFailures = prev.consecutiveFailures + 1;
  const suspended = consecutiveFailures >= opts.maxConsecutiveFailures ? true : prev.suspended;
  return { consecutiveFailures, consecutiveBroken: prev.consecutiveBroken, suspended, jobRunning: false };
}

/**
 * F6: cooperative Plex-recreate gate — mirrors the classic auto-heal cooldown +
 * consecutive-failure suspension so a persistently liveOk-false backing can never
 * spin a recreate loop. Purely functional so the gate is unit-testable.
 */
export interface CoopRecreateGate {
  /** Monotonic-ish ms of the last recreate ATTEMPT, or null. */
  lastAtMs: number | null;
  consecutiveFailures: number;
  suspended: boolean;
}

export function coopRecreateAllowed(gate: CoopRecreateGate, nowMs: number, cooldownSec: number): boolean {
  if (gate.suspended) return false;
  if (gate.lastAtMs !== null && nowMs - gate.lastAtMs < cooldownSec * 1000) return false;
  return true;
}

export function recordCoopRecreate(
  gate: CoopRecreateGate,
  nowMs: number,
  ok: boolean,
  maxConsecutiveFailures: number,
): CoopRecreateGate {
  if (ok) return { lastAtMs: nowMs, consecutiveFailures: 0, suspended: false };
  const consecutiveFailures = gate.consecutiveFailures + 1;
  return {
    lastAtMs: nowMs,
    consecutiveFailures,
    suspended: consecutiveFailures >= maxConsecutiveFailures,
  };
}

export interface MonitorDeps {
  adapter: HostAdapter;
  getSettings: () => Settings;
  restore: RestoreRunner;
  events?: EventLog;
  /** Present iff cooperative backing is available; classic mode never uses it. */
  backing?: BackingEngine;
}

export class Monitor {
  private history: MonitorHistory = {
    jobRunning: false,
    suspended: false,
    consecutiveBroken: 0,
    consecutiveFailures: 0,
    lastRestoreAt: null,
    drivePresentPrev: null,
  };

  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private ticking = false;
  private lastCheckAt: string | null = null;
  private lastActionAt: string | null = null;
  /** F6: cooldown + suspension gate for cooperative liveness-driven recreates. */
  private coopRecreateGate: CoopRecreateGate = { lastAtMs: null, consecutiveFailures: 0, suspended: false };

  constructor(private readonly deps: MonitorDeps) {}

  start(): void {
    this.stopped = false;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Reschedule after a settings change (interval may have changed). */
  reschedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.schedule();
  }

  /** Clear a suspension + failure counters (POST /api/reset-failures). */
  resetFailures(): void {
    this.history.suspended = false;
    this.history.consecutiveFailures = 0;
    this.history.consecutiveBroken = 0;
    this.deps.events?.info('monitor', 'auto-heal failure counters reset; suspension cleared');
  }

  /** Snapshot for the /api/status autoHeal field. */
  snapshot(): AutoHealStatus {
    return {
      enabled: this.deps.getSettings().autoHeal.enabled,
      lastCheckAt: this.lastCheckAt,
      lastActionAt: this.lastActionAt,
      consecutiveFailures: this.history.consecutiveFailures,
      suspended: this.history.suspended,
    };
  }

  private schedule(): void {
    if (this.stopped) return;
    const intervalSec = Math.max(1, this.deps.getSettings().autoHeal.intervalSec);
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule());
    }, intervalSec * 1000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** One monitor cycle: probe, account, decide, and possibly heal. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const settings = this.deps.getSettings();
      if (!settings.autoHeal.enabled) return;

      // Cooperative mode consults the backing ladder instead of the classic
      // decide()/restore auto-heal path (spec section 3). Classic mode below is
      // preserved byte-for-byte.
      if ((settings.mountMode ?? 'classic') === 'cooperative' && this.deps.backing) {
        await this.tickCooperative(settings);
        return;
      }

      let status: AppStatus;
      try {
        status = await probeStatus(this.deps.adapter, settings);
      } catch (e) {
        this.deps.events?.error('monitor', `status probe failed: ${errMsg(e)}`);
        return;
      }
      this.lastCheckAt = new Date().toISOString();

      this.history.jobRunning = this.deps.restore.isRunning();
      const drivePresent = status.drive.present;
      const healthy = isHealthy(status);

      // Drive reconnect transition releases a suspension.
      if (this.history.drivePresentPrev === false && drivePresent) {
        if (this.history.suspended) {
          this.deps.events?.info('monitor', 'drive reconnected — releasing auto-heal suspension');
        }
        this.history.suspended = false;
        this.history.consecutiveFailures = 0;
      }

      // Broken-streak accounting.
      if (healthy) {
        this.history.consecutiveBroken = 0;
        this.history.consecutiveFailures = 0;
        this.history.suspended = false;
      } else if (drivePresent && status.plex.found) {
        this.history.consecutiveBroken += 1;
      } else {
        this.history.consecutiveBroken = 0;
      }

      const decision = decide(status, settings, this.history);
      this.history.drivePresentPrev = drivePresent;

      if (decision.action === 'alert') {
        this.deps.events?.warn('monitor', `alert: ${decision.reason}`);
        return;
      }
      if (decision.action !== 'restore') return;

      // Fire an auto restore and wait for it, to update failure bookkeeping.
      this.history.lastRestoreAt = new Date().toISOString();
      this.lastActionAt = this.history.lastRestoreAt;
      this.deps.events?.info('monitor', `auto-heal triggered: ${decision.reason}`);

      const started = this.deps.restore.start('auto');
      if (!started.ok) return;
      this.history.jobRunning = true;

      await this.waitForJob();

      // Only a finished job updates the counters; a job still running at the
      // deadline updates NOTHING (jobRunning stays true so the next tick guards).
      const wasSuspended = this.history.suspended;
      const outcome = bookRestoreOutcome(
        {
          consecutiveFailures: this.history.consecutiveFailures,
          consecutiveBroken: this.history.consecutiveBroken,
          suspended: this.history.suspended,
          jobRunning: this.history.jobRunning,
        },
        {
          isRunning: this.deps.restore.isRunning(),
          job: this.deps.restore.getJob(),
          maxConsecutiveFailures: settings.autoHeal.maxConsecutiveFailures,
        },
      );
      this.history.jobRunning = outcome.jobRunning;
      this.history.consecutiveFailures = outcome.consecutiveFailures;
      this.history.consecutiveBroken = outcome.consecutiveBroken;
      this.history.suspended = outcome.suspended;
      if (outcome.suspended && !wasSuspended) {
        this.deps.events?.warn(
          'monitor',
          `auto-heal suspended after ${outcome.consecutiveFailures} consecutive failures`,
        );
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * One cooperative backing tick (spec sections 3, 5): consult the A-E ladder,
   * apply the action with the section-10 rails, and recreate Plex on a bind
   * change or the bind-generation / liveness rule. Guarded by the same
   * single-flight restore lock so it never races a switch/restore job.
   */
  private async tickCooperative(settings: Settings): Promise<void> {
    const backing = this.deps.backing!;
    const log = (line: string): void => this.deps.events?.info('backing', line);

    // F4: the ENTIRE cooperative mutating tick runs under the SAME single-flight
    // lock as restore/switch jobs. If a job (or a concurrent tick) holds it, this
    // tick is skipped — it never interleaves mount/backing.json mutations with a
    // switch. evaluate()/reap()/doBind()/… run only inside the lock, so the state
    // they read and mutate cannot be raced by a job landing mid-tick.
    const result = await this.deps.restore.withCoopLock(async () => {
      let evalRes;
      try {
        evalRes = await backing.evaluate(settings);
      } catch (e) {
        this.deps.events?.error('monitor', `backing evaluate failed: ${errMsg(e)}`);
        return;
      }
      this.lastCheckAt = new Date().toISOString();
      const { view, decision } = evalRes;

      let changed = false;
      try {
        switch (decision.action) {
          case 'wait':
            this.deps.events?.info('monitor', `backing: ${decision.reason}`);
            // Reap leftover/dead dirs so umbreld can reuse the clean name.
            await backing.reap(settings, log);
            break;
          case 'bind':
          case 'handover':
            this.deps.events?.info('monitor', `backing: ${decision.reason}`);
            if (view.umbrelMount.path !== null) {
              changed = await backing.doBind(view.umbrelMount.path, view, settings, log);
            }
            break;
          case 'direct-mount':
            this.deps.events?.warn('monitor', `backing: ${decision.reason}`);
            changed = await backing.doDirectMount(view, settings, log);
            break;
          case 'release':
            this.deps.events?.warn('monitor', `backing: ${decision.reason}`);
            await backing.doRelease(view, settings, log);
            break;
          case 'none':
            break;
        }

        if (changed) {
          this.lastActionAt = new Date().toISOString();
          await backing.recreate(settings, log);
          return;
        }

        // No bind change this tick: apply the Plex-liveness / bind-generation
        // recreate rule (never after a release — there is nothing to point at).
        if (decision.action !== 'release') {
          const status = await probeStatus(this.deps.adapter, settings, {
            backing: await backing.backingStatus(settings),
          });
          const need = plexNeedsRecreate(status, backing.getRecord());
          if (need.recreate) {
            // F6: gate the liveness-driven recreate with a cooldown + consecutive
            // -failure suspension (like the classic auto-heal path) so a stuck
            // liveOk-false backing cannot spin a recreate loop.
            const ah = settings.autoHeal;
            const nowMs = Date.now();
            if (!coopRecreateAllowed(this.coopRecreateGate, nowMs, ah.cooldownSec)) {
              this.deps.events?.info(
                'monitor',
                this.coopRecreateGate.suspended
                  ? 'skipping Plex recreate: cooperative recreate is suspended after repeated failures'
                  : 'skipping Plex recreate: within the cooperative recreate cooldown',
              );
            } else {
              this.deps.events?.info('monitor', `recreating Plex: ${need.reason}`);
              this.lastActionAt = new Date().toISOString();
              const ok = await backing.recreate(settings, log);
              const wasSuspended = this.coopRecreateGate.suspended;
              this.coopRecreateGate = recordCoopRecreate(
                this.coopRecreateGate,
                nowMs,
                ok,
                ah.maxConsecutiveFailures,
              );
              if (this.coopRecreateGate.suspended && !wasSuspended) {
                this.deps.events?.warn(
                  'monitor',
                  `cooperative Plex recreate suspended after ${this.coopRecreateGate.consecutiveFailures} consecutive failures`,
                );
              }
            }
          }
        }
      } catch (e) {
        this.deps.events?.error('monitor', `backing tick failed: ${errMsg(e)}`);
      }
    });
    if (!result.ran) {
      // A restore/switch job (or a concurrent tick) holds the shared lock.
      return;
    }
  }

  private async waitForJob(): Promise<void> {
    const deadline = Date.now() + 120_000;
    while (this.deps.restore.isRunning() && Date.now() < deadline) {
      await delay(50);
    }
  }
}
