// Tests for the guided mode-switch job (spec section 6). Drives B1's real
// BackingEngine + RestoreRunner (wired exactly as main.ts does) against the
// coexistence mock, so the whole switch runs in-memory:
//   set-mode -> reap -> unmount -> rescan -> wait-umbrel -> bind -> recreate -> verify.
//
// Three paths per the deliverable:
//   * happy: sysfs replug succeeds -> umbreld mounts -> bind + recreate -> healthy,
//   * failure revert: a recreate failure reverts to a DIRECT mount (Plex kept live),
//   * replug-unavailable: sysfs replug fails -> the job ends with a manual
//     unplug/replug INSTRUCTION and leaves the monitor to finish (ladder A).
//
// The switch's wait-for-umbrel poll is bounded by graceSec; we inject a 1s grace
// via the getSettings wrapper so the (deliberate) timeout path stays fast.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BackingEngine } from './backingEngine.js';
import { EventLog } from './events.js';
import { createMockAdapter, type MockScenario } from './mockAdapter.js';
import { createRestoreRunner, type RestoreRunner } from './restore.js';
import { defaultSettings, SettingsStore } from './settings.js';
import type { RestoreJob } from './types.js';

interface Harness {
  store: SettingsStore;
  adapter: ReturnType<typeof createMockAdapter>;
  backing: BackingEngine;
  restore: RestoreRunner;
  cleanup: () => void;
}

/** Wire BackingEngine + RestoreRunner exactly like main.ts, over the mock. */
function harness(scenario: MockScenario): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'drp-switch-'));
  const store = new SettingsStore(dir, defaultSettings()); // mountMode "classic"
  // Tiny grace so the (only) timeout path — replug-unavailable — completes fast.
  const getSettings = () => ({ ...store.get(), graceSec: 1 });
  const adapter = createMockAdapter(scenario);
  const events = new EventLog();
  const backing = new BackingEngine(adapter, getSettings, events, dir);
  const restore = createRestoreRunner(adapter, getSettings, events, dir, {
    backing,
    settings: store,
    onModeChange: () => {},
  });
  return { store, adapter, backing, restore, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitJob(restore: RestoreRunner, timeoutMs = 10_000): Promise<RestoreJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const j = restore.getJob();
    if (j && !j.running) return j;
    if (Date.now() > deadline) throw new Error('timed out waiting for switch job');
    await delay(20);
  }
}

function step(job: RestoreJob, name: string): string | undefined {
  return job.steps.find((s) => s.name === name)?.state;
}

function stepNames(job: RestoreJob): string[] {
  return job.steps.map((s) => s.name);
}

// ---------------------------------------------------------------------------
// Happy path — full cooperative switch.
// ---------------------------------------------------------------------------

test('switch->cooperative: happy path runs the full step sequence and ends umbrel-bind', async () => {
  const h = harness('healthy'); // classic direct mount, drive present, Plex running
  try {
    const started = h.restore.startSwitch('cooperative');
    assert.equal(started.ok, true);

    const job = await waitJob(h.restore);
    assert.equal(job.trigger, 'switch-cooperative');

    // Step order + all-ok on the happy path.
    assert.deepEqual(stepNames(job), [
      'set-mode',
      'reap',
      'unmount',
      'rescan',
      'wait-umbrel',
      'bind',
      'recreate',
      'verify',
    ]);
    for (const s of job.steps) {
      assert.equal(s.state, 'ok', `step ${s.name} should be ok, got ${s.state}`);
    }

    assert.match(job.result as string, /cooperative/i);
    assert.equal(h.store.get().mountMode, 'cooperative', 'mountMode persisted');
    assert.equal(h.backing.getRecord().active, 'umbrel-bind', 'backing record is umbrel-bind');
    assert.ok(h.adapter.umbrelMountPath(), 'umbreld has an /External mount of the drive');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Failure revert — a recreate failure must leave a working DIRECT mount.
// ---------------------------------------------------------------------------

test('switch->cooperative: a recreate failure reverts to a direct mount (Plex never left dark)', async () => {
  const h = harness('healthy');
  try {
    h.adapter.setRecreateFails(true); // docker compose up will fail

    h.restore.startSwitch('cooperative');
    const job = await waitJob(h.restore);

    // The bind still happened; the recreate is where it broke, then it reverted.
    assert.equal(step(job, 'bind'), 'ok');
    assert.equal(step(job, 'recreate'), 'failed', 'the recreate step failed');
    assert.match(job.result as string, /revert(ed)? to a direct mount/i);

    // mountMode stays cooperative but the ACTIVE backing is now the direct fallback.
    assert.equal(h.store.get().mountMode, 'cooperative', 'mode stays cooperative');
    assert.equal(h.backing.getRecord().active, 'direct', 'backing reverted to direct');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Replug-unavailable — the sysfs replug cannot be synthesized; the job finishes
// with a manual unplug/replug instruction and defers bind/recreate to the monitor.
// ---------------------------------------------------------------------------

test('switch->cooperative: sysfs replug unavailable -> ends with a manual replug instruction', async () => {
  const h = harness('healthy');
  try {
    h.adapter.setReplugAvailable(false); // no USB `authorized` dir -> manual replug

    h.restore.startSwitch('cooperative');
    const job = await waitJob(h.restore);

    assert.equal(step(job, 'set-mode'), 'ok');
    assert.equal(step(job, 'unmount'), 'ok');
    assert.equal(step(job, 'rescan'), 'ok');
    assert.equal(step(job, 'wait-umbrel'), 'ok');
    // bind + recreate are DEFERRED (the monitor finishes them once the user replugs).
    assert.equal(step(job, 'bind'), 'skipped');
    assert.equal(step(job, 'recreate'), 'skipped');
    assert.equal(step(job, 'verify'), 'ok');
    assert.match(job.result as string, /unplug and replug/i);

    assert.equal(h.store.get().mountMode, 'cooperative', 'mode still switched to cooperative');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Reverse switch back to classic.
// ---------------------------------------------------------------------------

test('switch->classic: from a cooperative bind, reverts to a direct mount and stays healthy', async () => {
  const h = harness('coopHealthy');
  try {
    // Seed the record so the engine knows it currently holds a cooperative bind.
    const first = h.restore.startSwitch('classic');
    assert.equal(first.ok, true);
    const job = await waitJob(h.restore);

    assert.equal(job.trigger, 'switch-classic');
    assert.equal(step(job, 'verify'), 'ok', `switch-classic verify not ok: ${job.result}`);
    assert.equal(h.store.get().mountMode, 'classic', 'mountMode persisted back to classic');
    assert.equal(h.backing.getRecord().active, 'direct', 'backing is a direct mount again');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Single-flight: a switch is rejected while a job is already running.
// ---------------------------------------------------------------------------

test('switch: startSwitch is rejected while a job is already running (shared lock)', async () => {
  const h = harness('healthy');
  try {
    const first = h.restore.startSwitch('cooperative');
    const second = h.restore.startSwitch('cooperative'); // synchronous, before any await
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    if (!second.ok) assert.ok(second.error.length > 0);
    await waitJob(h.restore);
  } finally {
    h.cleanup();
  }
});
