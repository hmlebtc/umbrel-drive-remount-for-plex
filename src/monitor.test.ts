// Tests for monitor.ts (spec section 8, section 10 frozen signature):
//
//   export function decide(
//     status: AppStatus,
//     settings: Settings,
//     history: MonitorHistory,
//   ): { action: "none" | "restore" | "alert"; reason: string }
//
// monitor.ts is owned by B1 and does not exist at the time this file was
// written (B1 builds in parallel) — this test is written strictly against
// the frozen signature and the exact decision table in spec section 8:
//
//   1. job running                                          -> none
//   2. suspended (consecutiveFailures >= max)                -> none
//      (until drive-presence transition or POST /api/reset-failures)
//   3. drive absent                                          -> none
//   4. plex container not found                              -> alert
//   5. healthy (mounted ∧ ¬stale ∧ bindOk ∧ hookOk ∧ patchOk ∧ mediaOk) -> none; reset failure counter
//   6. broken seen < requireConsecutiveBroken consecutive checks -> none (debounce)
//   7. within cooldownSec of last restore attempt            -> none
//   8. else                                                  -> restore (trigger "auto")
//   + suspension release on a drive-presence transition
//
// ASSUMPTION (flagged for the integration agent): AppStatus and Settings are
// imported from "./types.js" per spec sections 5 and 9. MonitorHistory's
// exact field names are NOT frozen by the spec (only its type name, used in
// decide()'s signature, is) — it is assumed here to also live in
// "./types.js" and to carry the fields a monitor tick loop must persist
// between calls: jobRunning, suspended, consecutiveBroken (debounce counter),
// consecutiveFailures (restore-attempt counter driving suspension),
// lastRestoreAt (ISO timestamp | null, for cooldown), and drivePresentPrev
// (boolean | null, the previous tick's drive.present, used to detect the
// reconnect transition that releases a suspension). If B1's actual
// MonitorHistory shape differs, these tests' object literals need field
// renames only — the assertions/behavior they encode should not change.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bookRestoreOutcome, decide, type RestoreBookkeeping } from "./monitor.js";
import type { AppStatus, MonitorHistory, RestoreJob, Settings } from "./types.js";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function baseSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    uuid: "555bf6f0-ae17-4137-adec-e91818854f1c",
    fsType: "ext4",
    mountPoint: "/mnt/wdexternal",
    mediaSubdir: "media",
    folders: ["Movies", "TVshows", "Music"],
    plexAppId: "plex",
    umbrelRoot: "/home/umbrel/umbrel",
    containerMediaPath: "/media/wdexternal",
    autoHeal: {
      enabled: true,
      intervalSec: 30,
      cooldownSec: 300,
      maxConsecutiveFailures: 3,
      requireConsecutiveBroken: 2,
    },
    ...overrides,
  } as Settings;
}

function healthyStatus(overrides: Partial<AppStatus> = {}): AppStatus {
  return {
    timestamp: "2026-07-08T12:00:00.000Z",
    version: "0.1.0",
    gitSha: "abc1234",
    drive: { present: true, device: "/dev/sdb1" },
    mount: { mounted: true, stale: false, source: "/dev/sdb1", target: "/mnt/wdexternal", fsType: "ext4", rw: true },
    bootHook: { ok: true, path: "/home/umbrel/umbrel/custom-hooks/pre-start", problems: [] },
    composePatch: {
      ok: true,
      path: "/home/umbrel/umbrel/app-data/plex/docker-compose.yml",
      problems: [],
      legacyOverridePresent: false,
      legacyFstabEntryPresent: false,
    },
    plex: { found: true, containerName: "plex_server_1", state: "running", bindOk: true, binds: [] },
    media: { ok: true, folders: [{ name: "Movies", present: true, entries: 12 }] },
    autoHeal: { enabled: true, lastCheckAt: "2026-07-08T12:00:00.000Z", lastActionAt: null, consecutiveFailures: 0, suspended: false },
    lastRestore: null,
    ...overrides,
  } as AppStatus;
}

function baseHistory(overrides: Partial<MonitorHistory> = {}): MonitorHistory {
  return {
    jobRunning: false,
    suspended: false,
    consecutiveBroken: 0,
    consecutiveFailures: 0,
    lastRestoreAt: null,
    drivePresentPrev: true,
    ...overrides,
  } as MonitorHistory;
}

function assertAction(result: { action: string; reason: string }, expected: string): void {
  assert.equal(result.action, expected, `expected action "${expected}", got "${result.action}" (reason: ${result.reason})`);
  assert.equal(typeof result.reason, "string");
  assert.ok(result.reason.length > 0, "reason should be a non-empty explanation");
}

// ---------------------------------------------------------------------------
// 1. job running -> none (even against an otherwise broken, non-suspended status)
// ---------------------------------------------------------------------------

test("decide: a running job always short-circuits to none", () => {
  const status = healthyStatus({ mount: { mounted: false, stale: true, source: "", target: "/mnt/wdexternal", fsType: "ext4", rw: false } });
  const history = baseHistory({ jobRunning: true, consecutiveBroken: 9 });
  const result = decide(status, baseSettings(), history);
  assertAction(result, "none");
});

// ---------------------------------------------------------------------------
// 2. suspended -> none (until drive-presence transition or reset)
// ---------------------------------------------------------------------------

test("decide: suspended (consecutiveFailures >= max) -> none, even when broken and debounced", () => {
  const settings = baseSettings();
  const status = healthyStatus({
    composePatch: {
      ok: false,
      path: "x",
      problems: ["missing volumes key"],
      legacyOverridePresent: false,
      legacyFstabEntryPresent: false,
    },
  });
  const history = baseHistory({
    suspended: true,
    consecutiveFailures: settings.autoHeal.maxConsecutiveFailures,
    consecutiveBroken: settings.autoHeal.requireConsecutiveBroken + 5,
    drivePresentPrev: true,
  });
  const result = decide(status, settings, history);
  assertAction(result, "none");
});

// ---------------------------------------------------------------------------
// 3. drive absent -> none (takes priority over a simultaneously-missing plex container)
// ---------------------------------------------------------------------------

test("decide: drive absent -> none, even if plex is also not found", () => {
  const status = healthyStatus({
    drive: { present: false, device: null },
    plex: { found: false, containerName: null, state: null, bindOk: false, binds: [] },
  });
  const history = baseHistory({ drivePresentPrev: false });
  const result = decide(status, baseSettings(), history);
  assertAction(result, "none");
});

// ---------------------------------------------------------------------------
// 4. plex container not found -> alert only
// ---------------------------------------------------------------------------

test("decide: drive present but plex container not found -> alert", () => {
  const status = healthyStatus({
    plex: { found: false, containerName: null, state: null, bindOk: false, binds: [] },
  });
  const history = baseHistory();
  const result = decide(status, baseSettings(), history);
  assertAction(result, "alert");
});

// ---------------------------------------------------------------------------
// 5. healthy -> none (regardless of stale non-zero counters left over in history)
// ---------------------------------------------------------------------------

test("decide: fully healthy status -> none, even with nonzero leftover counters", () => {
  const status = healthyStatus();
  const history = baseHistory({ consecutiveBroken: 5, consecutiveFailures: 1 });
  const result = decide(status, baseSettings(), history);
  assertAction(result, "none");
});

// ---------------------------------------------------------------------------
// 6. broken but below requireConsecutiveBroken -> none (debounce)
// ---------------------------------------------------------------------------

test("decide: broken but debounce threshold not yet reached -> none", () => {
  const settings = baseSettings({
    autoHeal: { enabled: true, intervalSec: 30, cooldownSec: 300, maxConsecutiveFailures: 3, requireConsecutiveBroken: 2 },
  });
  const status = healthyStatus({
    mount: { mounted: true, stale: true, source: "/dev/sdb1", target: "/mnt/wdexternal", fsType: "ext4", rw: true },
  });
  const history = baseHistory({ consecutiveBroken: 1 }); // < requireConsecutiveBroken (2)
  const result = decide(status, settings, history);
  assertAction(result, "none");
});

// ---------------------------------------------------------------------------
// 7. within cooldownSec of the last restore attempt -> none
// ---------------------------------------------------------------------------

test("decide: broken, debounce satisfied, but within cooldown window -> none", () => {
  const settings = baseSettings({
    autoHeal: { enabled: true, intervalSec: 30, cooldownSec: 300, maxConsecutiveFailures: 3, requireConsecutiveBroken: 2 },
  });
  const now = "2026-07-08T12:00:00.000Z";
  const status = healthyStatus({
    timestamp: now,
    mount: { mounted: true, stale: true, source: "/dev/sdb1", target: "/mnt/wdexternal", fsType: "ext4", rw: true },
  });
  // 60s ago -> well within a 300s cooldown.
  const history = baseHistory({ consecutiveBroken: 2, lastRestoreAt: "2026-07-08T11:59:00.000Z" });
  const result = decide(status, settings, history);
  assertAction(result, "none");
});

// ---------------------------------------------------------------------------
// 8. else -> restore
// ---------------------------------------------------------------------------

test("decide: broken, debounce satisfied, cooldown elapsed -> restore", () => {
  const settings = baseSettings({
    autoHeal: { enabled: true, intervalSec: 30, cooldownSec: 300, maxConsecutiveFailures: 3, requireConsecutiveBroken: 2 },
  });
  const now = "2026-07-08T12:00:00.000Z";
  const status = healthyStatus({
    timestamp: now,
    mount: { mounted: true, stale: true, source: "/dev/sdb1", target: "/mnt/wdexternal", fsType: "ext4", rw: true },
  });
  // 20 minutes ago -> well past a 300s cooldown.
  const history = baseHistory({ consecutiveBroken: 2, lastRestoreAt: "2026-07-08T11:40:00.000Z" });
  const result = decide(status, settings, history);
  assertAction(result, "restore");
});

test("decide: broken, debounce satisfied, no prior restore ever attempted -> restore", () => {
  const settings = baseSettings();
  const status = healthyStatus({
    bootHook: { ok: false, path: "x", problems: ["hook missing"] },
  });
  const history = baseHistory({ consecutiveBroken: 2, lastRestoreAt: null });
  const result = decide(status, settings, history);
  assertAction(result, "restore");
});

// ---------------------------------------------------------------------------
// Suspension release on a drive-presence transition.
// ---------------------------------------------------------------------------

test("decide: a drive-presence transition (absent -> present) releases a suspension", () => {
  const settings = baseSettings({
    autoHeal: { enabled: true, intervalSec: 30, cooldownSec: 300, maxConsecutiveFailures: 3, requireConsecutiveBroken: 2 },
  });
  const status = healthyStatus({
    drive: { present: true, device: "/dev/sdb1" },
    mount: { mounted: false, stale: false, source: "", target: "/mnt/wdexternal", fsType: "ext4", rw: false },
  });
  const history = baseHistory({
    suspended: true,
    drivePresentPrev: false, // drive was absent last tick, is present now -> transition
    consecutiveBroken: 2, // debounce already satisfied
    consecutiveFailures: settings.autoHeal.maxConsecutiveFailures,
    lastRestoreAt: null,
  });
  const result = decide(status, settings, history);
  // Suspension must be released on this transition, so the decision falls
  // through to the normal broken/debounce/cooldown evaluation -> restore.
  assertAction(result, "restore");
});

test("decide: repeated drive presence (no transition) leaves a suspension in effect", () => {
  const settings = baseSettings();
  const status = healthyStatus({
    drive: { present: true, device: "/dev/sdb1" },
    mount: { mounted: false, stale: false, source: "", target: "/mnt/wdexternal", fsType: "ext4", rw: false },
  });
  const history = baseHistory({
    suspended: true,
    drivePresentPrev: true, // already present last tick -> no transition
    consecutiveBroken: 5,
    consecutiveFailures: settings.autoHeal.maxConsecutiveFailures,
    lastRestoreAt: null,
  });
  const result = decide(status, settings, history);
  assertAction(result, "none");
});

// ---------------------------------------------------------------------------
// bookRestoreOutcome (fix #8): only a FINISHED job updates counters. A job
// still running at the wait deadline must update NOTHING (previously it was
// mis-booked as a success, resetting the failure counter and letting a slow
// failing restore evade suspension).
// ---------------------------------------------------------------------------

function bk(overrides: Partial<RestoreBookkeeping> = {}): RestoreBookkeeping {
  return { consecutiveFailures: 0, consecutiveBroken: 0, suspended: false, jobRunning: false, ...overrides };
}

function job(overrides: Partial<RestoreJob> = {}): RestoreJob {
  return {
    running: false,
    jobId: "j1",
    trigger: "auto",
    startedAt: "2026-07-08T12:00:00.000Z",
    finishedAt: "2026-07-08T12:00:10.000Z",
    steps: [{ name: "preflight", state: "ok", log: [] }],
    result: "ok",
    ...overrides,
  } as RestoreJob;
}

test("bookRestoreOutcome: finished + no failed step -> success resets counters", () => {
  const out = bookRestoreOutcome(bk({ consecutiveFailures: 2, consecutiveBroken: 3 }), {
    isRunning: false,
    job: job(),
    maxConsecutiveFailures: 3,
  });
  assert.deepEqual(out, { consecutiveFailures: 0, consecutiveBroken: 0, suspended: false, jobRunning: false });
});

test("bookRestoreOutcome: finished + a failed step -> increments failures", () => {
  const out = bookRestoreOutcome(bk({ consecutiveFailures: 1 }), {
    isRunning: false,
    job: job({ steps: [{ name: "mount", state: "failed", log: [] }] }),
    maxConsecutiveFailures: 3,
  });
  assert.equal(out.consecutiveFailures, 2);
  assert.equal(out.suspended, false);
  assert.equal(out.jobRunning, false);
});

test("bookRestoreOutcome: finished failure reaching the max -> suspended", () => {
  const out = bookRestoreOutcome(bk({ consecutiveFailures: 2 }), {
    isRunning: false,
    job: job({ steps: [{ name: "mount", state: "failed", log: [] }] }),
    maxConsecutiveFailures: 3,
  });
  assert.equal(out.consecutiveFailures, 3);
  assert.equal(out.suspended, true);
});

test("bookRestoreOutcome: STILL RUNNING at deadline -> updates NOTHING but jobRunning stays true", () => {
  // The regression: a running job whose steps are all still pending has no
  // failed step, so the old code booked it as a success and reset the counter.
  const prev = bk({ consecutiveFailures: 2, consecutiveBroken: 4, suspended: false });
  const running = job({ running: true, finishedAt: null, steps: [{ name: "mount", state: "running", log: [] }], result: null });
  const out = bookRestoreOutcome(prev, { isRunning: true, job: running, maxConsecutiveFailures: 3 });
  assert.equal(out.consecutiveFailures, 2, "must NOT reset the failure counter");
  assert.equal(out.consecutiveBroken, 4, "must NOT reset the broken counter");
  assert.equal(out.suspended, false);
  assert.equal(out.jobRunning, true, "jobRunning stays true so the next tick guards");
});

test("bookRestoreOutcome: not-yet-finished (finishedAt null even if !isRunning) -> updates nothing", () => {
  const prev = bk({ consecutiveFailures: 1 });
  const out = bookRestoreOutcome(prev, {
    isRunning: false,
    job: job({ finishedAt: null }),
    maxConsecutiveFailures: 3,
  });
  assert.equal(out.consecutiveFailures, 1);
  assert.equal(out.jobRunning, true);
});

test("bookRestoreOutcome: null job -> updates nothing, jobRunning stays true", () => {
  const out = bookRestoreOutcome(bk({ consecutiveFailures: 2 }), {
    isRunning: false,
    job: null,
    maxConsecutiveFailures: 3,
  });
  assert.equal(out.consecutiveFailures, 2);
  assert.equal(out.jobRunning, true);
});
