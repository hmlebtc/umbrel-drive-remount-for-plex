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

const EXTERNAL_BASE = `${defaultSettings().umbrelRoot}/external`;

/**
 * Put the harness into an ALREADY-cooperative state bound to a drifted "(2)"
 * umbrelOS mount (the live box before a reclaim): persist cooperative mode and
 * establish the umbrel-bind record via doBind. Returns the harness.
 */
async function setupDriftedBind(scenario: MockScenario): Promise<Harness> {
  const h = harness(scenario);
  h.store.update({ mountMode: 'cooperative' });
  h.backing.setMode('cooperative');
  const settings = h.store.get();
  const { view } = await h.backing.classify(settings);
  assert.ok(view.umbrelMount.path, 'scenario ships a drifted umbrelMount');
  await h.backing.doBind(view.umbrelMount.path!, view, settings, () => {});
  const info = await h.backing.driftInfo(h.store.get());
  assert.equal(info.driftedName, true, 'harness is bound to a drifted "(N)" name');
  return h;
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
// Replug-unavailable — the sysfs replug cannot be synthesized. F10: the job must
// NOT report success while /mnt/wdexternal is unmounted; it re-mounts DIRECTLY by
// UUID so Plex keeps serving (mode stays cooperative; the monitor hands over via
// ladder A once the user replugs). The umbrelOS bind stays deferred.
// ---------------------------------------------------------------------------

test('switch->cooperative: sysfs replug unavailable -> direct-mounts so Plex keeps serving + manual replug instruction (F10)', async () => {
  const h = harness('healthy');
  try {
    h.adapter.setReplugAvailable(false); // no USB `authorized` dir -> manual replug

    h.restore.startSwitch('cooperative');
    const job = await waitJob(h.restore);

    assert.equal(step(job, 'set-mode'), 'ok');
    assert.equal(step(job, 'unmount'), 'ok');
    assert.equal(step(job, 'rescan'), 'ok');
    assert.equal(step(job, 'wait-umbrel'), 'ok');
    // The umbrelOS BIND stays deferred to the monitor (once the user replugs)...
    assert.equal(step(job, 'bind'), 'skipped');
    // ...but Plex is kept serving via a direct mount, so recreate + verify are OK.
    assert.equal(step(job, 'recreate'), 'ok', 'Plex is recreated onto the direct mount so it is not dark');
    assert.equal(step(job, 'verify'), 'ok');
    assert.match(job.result as string, /unplug and replug/i);
    assert.match(job.result as string, /direct mount/i);

    assert.equal(h.store.get().mountMode, 'cooperative', 'mode still switched to cooperative');
    // F10: the stable path is NOT left unmounted — Plex has a working backing.
    assert.equal(h.backing.getRecord().active, 'direct', 'backing is a direct mount (not "none"/dark)');
    const live = await h.backing.deviceLiveMounts(h.store.get());
    assert.ok(live.includes('/mnt/wdexternal'), 'the stable path is mounted (Plex keeps serving)');
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
// Reclaim clean name (spec §8, v0.2.1) — a re-handover from a drifted "(2)" bind.
// ---------------------------------------------------------------------------

test('reclaim: drifted "(2)" + empty-tree leftover -> ends bound to the CLEAN name, leftover gone, healthy', async () => {
  const h = await setupDriftedBind('driftReclaimable');
  try {
    // Sanity: we start on the drifted "(2)" name with the leftover present.
    assert.equal(h.adapter.umbrelMountPath(), `${EXTERNAL_BASE}/wdexternal (2)`);

    const started = h.restore.startSwitch('cooperative'); // re-handover
    assert.equal(started.ok, true);
    const job = await waitJob(h.restore);

    assert.equal(step(job, 'reap'), 'ok');
    assert.equal(step(job, 'bind'), 'ok');
    assert.equal(step(job, 'verify'), 'ok', `reclaim verify not ok: ${job.result}`);

    // Reclaimed: bound to the CLEAN name; umbreld remounted clean; leftover gone.
    assert.equal(h.backing.getRecord().boundTo, `${EXTERNAL_BASE}/wdexternal`, 'bound to the clean name');
    assert.equal(h.adapter.umbrelMountPath(), `${EXTERNAL_BASE}/wdexternal`, 'umbreld mounted at the clean name');
    assert.equal(
      await h.adapter.statType(`${EXTERNAL_BASE}/wdexternal/skeleton`),
      null,
      'the empty leftover skeleton was cleared',
    );
    const info = await h.backing.driftInfo(h.store.get());
    assert.equal(info.driftedName, false, 'no longer drifted');
  } finally {
    h.cleanup();
  }
});

test('reclaim: drifted "(2)" + has-files leftover -> stays on "(2)", warning surfaced, NOTHING deleted', async () => {
  const h = await setupDriftedBind('driftHasFiles');
  try {
    const filePath = `${EXTERNAL_BASE}/wdexternal/skeleton/movie.mkv`;
    assert.equal(await h.adapter.statType(filePath), 'file', 'the leftover file exists before');

    h.restore.startSwitch('cooperative');
    const job = await waitJob(h.restore);

    // The churn is SKIPPED; only verify runs (system healthy on the current mount).
    for (const n of ['reap', 'unmount', 'rescan', 'wait-umbrel', 'bind', 'recreate']) {
      assert.equal(step(job, n), 'skipped', `step ${n} should be skipped`);
    }
    assert.equal(step(job, 'verify'), 'ok');
    assert.match(job.result as string, /not reclaimed|contains files|reclaim/i);

    // Still on "(2)"; the file and its tree are entirely untouched.
    assert.equal(h.backing.getRecord().boundTo, `${EXTERNAL_BASE}/wdexternal (2)`, 'still bound to "(2)"');
    assert.equal(h.adapter.umbrelMountPath(), `${EXTERNAL_BASE}/wdexternal (2)`);
    assert.equal(await h.adapter.statType(filePath), 'file', 'the file was NOT deleted');

    // status surfaces LEFTOVER_HAS_FILES with the path.
    const { backing, warnings } = await h.backing.backingStatus(h.store.get());
    assert.ok(warnings.includes('LEFTOVER_HAS_FILES'), 'LEFTOVER_HAS_FILES warning surfaced');
    assert.equal(backing.cleanNameReclaimable, false);
    assert.equal(backing.leftoverPath, `${EXTERNAL_BASE}/wdexternal`);
  } finally {
    h.cleanup();
  }
});

test('reclaim: a recreate failure mid-reclaim reverts to a direct mount (Plex never dark)', async () => {
  const h = await setupDriftedBind('driftReclaimable');
  try {
    h.adapter.setRecreateFails(true); // docker compose up fails during the reclaim

    h.restore.startSwitch('cooperative');
    const job = await waitJob(h.restore);

    assert.match(job.result as string, /revert(ed)? to a direct mount/i);
    assert.equal(h.store.get().mountMode, 'cooperative', 'mode stays cooperative');
    assert.equal(h.backing.getRecord().active, 'direct', 'backing reverted to a direct mount');
    const live = await h.backing.deviceLiveMounts(h.store.get());
    assert.ok(live.includes('/mnt/wdexternal'), 'the stable path is mounted (Plex keeps serving)');
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

// ---------------------------------------------------------------------------
// F4: the cooperative monitor mutation participates in the SAME single-flight
// lock as restore/switch. While a coop mutation holds it, a switch/restore is
// rejected; while a job holds it, a coop mutation does not run. So the two can
// never interleave backing.json / mount writes.
// ---------------------------------------------------------------------------

test('F4: a coop mutation and a switch/restore job are mutually exclusive (shared lock)', async () => {
  const h = harness('coopHealthy');
  try {
    // Hold the coop lock across an await we control.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let insideStartSwitch: ReturnType<typeof h.restore.startSwitch> | undefined;
    let insideStart: ReturnType<typeof h.restore.start> | undefined;

    const held = h.restore.withCoopLock(async () => {
      // The shared lock reads as running to everyone else.
      assert.equal(h.restore.isRunning(), true, 'coop lock makes isRunning() true');
      // A switch and a restore attempted mid-mutation are both rejected.
      insideStartSwitch = h.restore.startSwitch('classic');
      insideStart = h.restore.start('auto');
      await gate;
      return 'done';
    });

    // Let the withCoopLock body run up to the await.
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(insideStartSwitch?.ok, false, 'switch rejected while a coop mutation holds the lock');
    assert.equal(insideStart?.ok, false, 'restore rejected while a coop mutation holds the lock');

    release();
    const outcome = await held;
    assert.deepEqual(outcome, { ran: true, value: 'done' });
    assert.equal(h.restore.isRunning(), false, 'lock released');

    // Conversely: while a switch job runs, a coop mutation does not run.
    h.restore.startSwitch('classic');
    const blocked = await h.restore.withCoopLock(async () => 'should-not-run');
    assert.deepEqual(blocked, { ran: false }, 'coop mutation is skipped while a job holds the lock');
    await waitJob(h.restore);
  } finally {
    h.cleanup();
  }
});
