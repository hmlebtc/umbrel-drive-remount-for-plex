// Tests for restore.ts (spec section 7 restore job; section 10 lists
// restore.ts among B1's owned files but does NOT freeze its exported
// signature — only composePatch/bootHook/mounts/monitor's pure functions are
// frozen). restore.ts, hostAdapter.ts and mockAdapter.ts do not exist at the
// time this file was written (B1 builds in parallel).
//
// ============================================================================
// ASSUMED CONTRACT (integration agent: reconcile names/shapes against B1's
// actual exports; the test *behavior* below should not need to change, only
// the import names / call shapes it hangs off of):
//
//   // mockAdapter.ts
//   export type MockScenario =
//     | "healthy" | "driveAbsent" | "mountStale" | "bindMissing"
//     | "composeUnpatched" | "hookMissing";
//   export function createMockAdapter(scenario: MockScenario): HostAdapter;
//   // (the mock exposes a mutable in-memory host: mounts table, files,
//   // docker state, per spec section 10's description of mockAdapter.ts)
//
//   // restore.ts
//   export function createRestoreRunner(
//     adapter: HostAdapter,
//     getSettings: () => Settings,
//   ): {
//     // Synchronous single-flight guard: returns {ok:false} immediately if a
//     // job is already running (needed so POST /api/restore can 409
//     // synchronously per spec section 9). The job itself then runs async.
//     start(trigger: "auto" | "manual" | "restart-plex"):
//       { ok: true; jobId: string } | { ok: false; error: string };
//     // Mirrors the exact GET /api/job shape from spec section 9 (also
//     // returns the last finished job when idle).
//     getJob(): {
//       running: boolean;
//       jobId: string | null;
//       trigger: string | null;
//       startedAt: string | null;
//       steps: Array<{
//         name: "preflight" | "bootHook" | "mount" | "composePatch" | "recreate" | "verify";
//         state: "pending" | "running" | "ok" | "failed" | "skipped";
//         log: Array<{ ts: string; line: string }>;
//       }>;
//       result: string | null;
//     } | null;
//   };
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMockAdapter, type MockScenario } from "./mockAdapter.js";
import { createRestoreRunner } from "./restore.js";
import type { Settings } from "./types.js";

function testSettings(overrides: Partial<Settings> = {}): Settings {
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

type Job = NonNullable<ReturnType<ReturnType<typeof createRestoreRunner>["getJob"]>>;

async function waitForJobDone(
  runner: ReturnType<typeof createRestoreRunner>,
  timeoutMs = 5000,
): Promise<Job> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = runner.getJob();
    if (job && !job.running) return job;
    if (Date.now() > deadline) throw new Error("timed out waiting for restore job to finish");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function stepState(job: Job, name: string): string | undefined {
  return job.steps.find((s) => s.name === name)?.state;
}

function stepLog(job: Job, name: string): string {
  const step = job.steps.find((s) => s.name === name);
  return (step?.log ?? []).map((l) => l.line).join("\n");
}

function runScenario(scenario: MockScenario, settings: Settings = testSettings()) {
  const adapter = createMockAdapter(scenario);
  const runner = createRestoreRunner(adapter, () => settings);
  return { adapter, runner };
}

// ---------------------------------------------------------------------------
// Healthy system -> no-op, no recreate.
// ---------------------------------------------------------------------------

test("restore: healthy system -> all steps ok/skipped, recreate skipped, already-healthy result", async () => {
  const { runner } = runScenario("healthy");
  const started = runner.start("manual");
  assert.equal(started.ok, true);

  const job = await waitForJobDone(runner);
  assert.equal(stepState(job, "recreate"), "skipped");
  for (const name of ["preflight", "bootHook", "mount", "composePatch", "verify"]) {
    const state = stepState(job, name);
    assert.ok(state === "ok" || state === "skipped", `expected step "${name}" to be ok/skipped, got "${state}"`);
  }
  assert.ok(job.result, "expected a non-null result");
  assert.match(job.result as string, /already[-_ ]?healthy/i);
});

// ---------------------------------------------------------------------------
// Mount is stale -> umount then mount; bind still present -> recreate skipped.
// ---------------------------------------------------------------------------

test("restore: stale mount -> mount step remounts (ok), recreate still skipped", async () => {
  const { runner } = runScenario("mountStale");
  runner.start("manual");
  const job = await waitForJobDone(runner);

  const mountStep = job.steps.find((s) => s.name === "mount");
  assert.ok(mountStep);
  assert.equal(mountStep!.state, "ok");
  assert.ok(mountStep!.log.length > 0, "expected the mount step to log its remount action");
  assert.equal(stepState(job, "recreate"), "skipped");
});

// ---------------------------------------------------------------------------
// Running Plex container is missing the bind -> recreate runs.
// ---------------------------------------------------------------------------

test("restore: bind missing on the running container -> recreate runs", async () => {
  const { runner } = runScenario("bindMissing");
  runner.start("manual");
  const job = await waitForJobDone(runner);

  assert.equal(stepState(job, "recreate"), "ok");
  assert.notEqual(stepState(job, "recreate"), "skipped");
});

// ---------------------------------------------------------------------------
// Compose not patched -> patch applied, then recreate (container predates the patch).
// ---------------------------------------------------------------------------

test("restore: compose unpatched -> composePatch runs, then recreate runs", async () => {
  const { runner } = runScenario("composeUnpatched");
  runner.start("manual");
  const job = await waitForJobDone(runner);

  assert.equal(stepState(job, "composePatch"), "ok");
  assert.equal(stepState(job, "recreate"), "ok");
});

// ---------------------------------------------------------------------------
// Only the boot hook is missing -> hook written, recreate SKIPPED (bind present).
// ---------------------------------------------------------------------------

test("restore: hook missing only -> hook written, recreate skipped", async () => {
  const { runner } = runScenario("hookMissing");
  runner.start("manual");
  const job = await waitForJobDone(runner);

  assert.equal(stepState(job, "bootHook"), "ok");
  assert.equal(stepState(job, "recreate"), "skipped");
});

// ---------------------------------------------------------------------------
// Failure in a step -> job failed, later steps not run.
// ---------------------------------------------------------------------------

test("restore: preflight failure (drive absent) -> job failed, no later step runs", async () => {
  const { runner } = runScenario("driveAbsent");
  runner.start("manual");
  const job = await waitForJobDone(runner);

  assert.equal(stepState(job, "preflight"), "failed");
  assert.match(job.result as string, /fail/i);
  for (const name of ["bootHook", "mount", "composePatch", "recreate", "verify"]) {
    const state = stepState(job, name);
    assert.notEqual(state, "ok", `step "${name}" should not have run after preflight failed`);
    assert.notEqual(state, "running", `step "${name}" should not be left running`);
  }
});

// ---------------------------------------------------------------------------
// Single-flight: a second restore while one is running is rejected.
// ---------------------------------------------------------------------------

test("restore: a second concurrent start() while a job is running is rejected", async () => {
  const { runner } = runScenario("healthy");

  const first = runner.start("manual");
  const second = runner.start("manual"); // called synchronously, before any await
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(typeof second.error, "string");
    assert.ok(second.error.length > 0);
  }

  await waitForJobDone(runner);

  // Once the first job has finished, starting a new one succeeds again.
  const third = runner.start("manual");
  assert.equal(third.ok, true);
  await waitForJobDone(runner);
});

// ---------------------------------------------------------------------------
// Fix #5: recreate tries `umbreld client` FIRST (before umbreld-client / docker).
// ---------------------------------------------------------------------------

test("restore: recreate attempts `umbreld client` first", async () => {
  const { runner } = runScenario("bindMissing");
  runner.start("manual");
  const job = await waitForJobDone(runner);

  assert.equal(stepState(job, "recreate"), "ok");
  const log = stepLog(job, "recreate");
  assert.match(log, /umbreld client/, "should attempt the `umbreld client` form first");
  assert.match(log, /recreated via umbreld client/, "should succeed via `umbreld client` in the mock");
});

// ---------------------------------------------------------------------------
// Fix #6: a bind with the right destination but the WRONG source must NOT count
// as present -> recreate runs and repairs it.
// ---------------------------------------------------------------------------

test("restore: bind destination present but source wrong -> recreate runs and heals", async () => {
  const { runner } = runScenario("bindWrongSource");
  runner.start("manual");
  const job = await waitForJobDone(runner);

  assert.equal(stepState(job, "recreate"), "ok", "wrong-source bind must trigger a recreate");
  assert.match(job.result as string, /healthy/i);
});

// ---------------------------------------------------------------------------
// Fix #4: a mutating write backs up the previous file under <dataDir>/backups.
// ---------------------------------------------------------------------------

test("restore: patching the compose backs up the previous file into <dataDir>/backups", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drp-restore-"));
  try {
    const settings = testSettings();
    const adapter = createMockAdapter("composeUnpatched");
    const runner = createRestoreRunner(adapter, () => settings, undefined, dir);
    runner.start("manual");
    const job = await waitForJobDone(runner);

    assert.equal(stepState(job, "composePatch"), "ok");
    assert.match(stepLog(job, "composePatch"), /backed up previous/, "should log the backup path");

    const backups = readdirSync(join(dir, "backups"));
    assert.ok(
      backups.some((n) => n.startsWith("docker-compose.yml.") && n.endsWith(".bak")),
      "a compose backup should have been written",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore: a hook that did not previously exist is NOT backed up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drp-restore-"));
  try {
    const settings = testSettings();
    const adapter = createMockAdapter("hookMissing");
    const runner = createRestoreRunner(adapter, () => settings, undefined, dir);
    runner.start("manual");
    const job = await waitForJobDone(runner);

    assert.equal(stepState(job, "bootHook"), "ok");
    // Nothing to back up (the file was absent) -> no pre-start backup, no log line.
    assert.doesNotMatch(stepLog(job, "bootHook"), /backed up previous/);
    const backupDir = join(dir, "backups");
    if (existsSync(backupDir)) {
      const hookBackups = readdirSync(backupDir).filter((n) => n.startsWith("pre-start."));
      assert.equal(hookBackups.length, 0, "an absent hook must not be backed up");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
