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

import type { EventLog } from './events.js';
import type { HostAdapter } from './hostAdapter.js';
import { isHealthy, probeStatus } from './status.js';
import type {
  AppStatus,
  AutoHealStatus,
  Decision,
  MonitorHistory,
  Settings,
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

export interface MonitorDeps {
  adapter: HostAdapter;
  getSettings: () => Settings;
  restore: RestoreRunner;
  events?: EventLog;
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
      this.history.jobRunning = false;
      const job = this.deps.restore.getJob();
      const ok = job !== null && !job.steps.some((s) => s.state === 'failed');
      if (ok) {
        this.history.consecutiveFailures = 0;
        this.history.consecutiveBroken = 0;
      } else {
        this.history.consecutiveFailures += 1;
        if (this.history.consecutiveFailures >= settings.autoHeal.maxConsecutiveFailures) {
          this.history.suspended = true;
          this.deps.events?.warn(
            'monitor',
            `auto-heal suspended after ${this.history.consecutiveFailures} consecutive failures`,
          );
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async waitForJob(): Promise<void> {
    const deadline = Date.now() + 120_000;
    while (this.deps.restore.isRunning() && Date.now() < deadline) {
      await delay(50);
    }
  }
}
