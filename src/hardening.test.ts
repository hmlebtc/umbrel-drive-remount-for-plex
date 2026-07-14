// Regression tests for the v0.2.0 adversarial-review fixes (data + physical
// safety). Each test reproduces the PROVEN exploit against the real BackingEngine
// (wired over the coexistence mock) and shows it dead.
//
//   F1  reap() must not tear down a LIVE mount (foreign, ours, or ours-under-EIO);
//       only a genuine zombie (source device ABSENT) is reaped.
//   F2  the sysfs replug must refuse while ANY partition of the physical disk is
//       still mounted (whole-disk guard).
//   F3  the grace window is anchored to THIS boot (monotonic), never a persisted
//       wall-clock — a stale/future stamp cannot fire grace early or forever.
//   F5  a direct mount is only persisted after the mount table corroborates it.
//   F8  reaping matches the drive's real FS label, not the mount-point basename.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BackingEngine } from './backingEngine.js';
import { EventLog } from './events.js';
import { createMockAdapter, type MockScenario } from './mockAdapter.js';
import { defaultSettings } from './settings.js';
import type { BackingRecord, Settings } from './types.js';

const EXTERNAL_BASE = '/home/umbrel/umbrel/external';

interface H {
  adapter: ReturnType<typeof createMockAdapter>;
  backing: BackingEngine;
  dir: string;
  cleanup: () => void;
}

function harness(scenario: MockScenario, settingsOverrides: Partial<Settings> = {}, record?: Partial<BackingRecord>): H {
  const dir = mkdtempSync(join(tmpdir(), 'drp-harden-'));
  if (record) {
    const full: BackingRecord = {
      mode: 'cooperative',
      active: 'none',
      boundTo: null,
      bindGeneration: 0,
      lastBindChangeAt: null,
      graceStartedAt: null,
      ...record,
    };
    writeFileSync(join(dir, 'backing.json'), JSON.stringify(full, null, 2), 'utf8');
  }
  const settings: Settings = { ...defaultSettings(), mountMode: 'cooperative', ...settingsOverrides };
  const adapter = createMockAdapter(scenario);
  const backing = new BackingEngine(adapter, () => settings, new EventLog(), dir);
  return { adapter, backing, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ===========================================================================
// F1 — reap safety.
// ===========================================================================

test('F1: reap() does NOT tear down OUR live umbrelOS mount under a transient EIO', async () => {
  const h = harness('coopHealthy');
  try {
    // The proven exploit: an EIO makes the live /External mount unlistable. The
    // OLD deadness rule (mounted && contents===null) would umount + rmdir our
    // LIVE mount. Its SOURCE DEVICE is still present, so the fix leaves it alone.
    h.adapter.setEio(`${EXTERNAL_BASE}/wdexternal`, true);
    assert.equal(await h.adapter.listDir(`${EXTERNAL_BASE}/wdexternal`), null, 'target is EIO/unreadable');
    assert.equal(await h.adapter.exists('/dev/sda1'), true, 'but the source device is present');

    const counts = await h.backing.reap(defaultSettingsCoop());
    assert.deepEqual(counts, { dirs: 0, mounts: 0 }, 'nothing reaped');
    assert.equal(h.adapter.umbrelMountPath(), `${EXTERNAL_BASE}/wdexternal`, 'the live umbrelOS mount survives');
  } finally {
    h.cleanup();
  }
});

test('F1: reap() DOES reap a genuine zombie (source absent) but preserves a live sibling', async () => {
  // bindStaleAfterReplug: a dead /External mount on the OLD device (/dev/sda1,
  // now gone) at "wdexternal", and a LIVE one on the new device (/dev/sdb1) at
  // "wdexternal (2)". Only the zombie is reaped.
  const h = harness('bindStaleAfterReplug');
  try {
    assert.equal(await h.adapter.exists('/dev/sda1'), false, 'the old device is gone (zombie source)');
    assert.equal(await h.adapter.exists('/dev/sdb1'), true, 'the live device is present');

    const counts = await h.backing.reap(defaultSettingsCoop());
    assert.equal(counts.mounts, 1, 'the zombie mount was lazy-umounted');
    assert.equal(counts.dirs, 1, 'and its now-empty dir removed');
    assert.equal(h.adapter.umbrelMountPath(), `${EXTERNAL_BASE}/wdexternal (2)`, 'the LIVE sibling mount survives');
  } finally {
    h.cleanup();
  }
});

// ===========================================================================
// F2 — sysfs whole-disk guard (physical safety).
// ===========================================================================

test('F2: sysfsReplug REFUSES while a sibling partition of the disk is still mounted', async () => {
  const h = harness('siblingPartitionMounted');
  try {
    const s = defaultSettingsCoop();
    // Our partition (sdc1) is unmounted, so the partition-scoped guard sees zero.
    assert.deepEqual(await h.backing.deviceLiveMounts(s), [], 'no live mounts of our partition');
    // But a sibling partition (sdc2) IS mounted -> the whole-disk guard vetoes.
    assert.ok((await h.backing.diskLiveMounts(s)).includes('/mnt/other'), 'a sibling partition is live');

    const r = await h.backing.sysfsReplug(s, () => {});
    assert.deepEqual(r, { ok: false, manual: true }, 'refused; falls back to manual replug');
    assert.equal(h.adapter.umbrelMountPath(), null, 'authorized was NOT toggled (no umbreld re-scan fired)');
  } finally {
    h.cleanup();
  }
});

// ===========================================================================
// F3 — grace anchored to boot, not a persisted wall-clock.
// ===========================================================================

test('F3: a STALE 1h-old persisted graceStartedAt still yields a FULL fresh grace after boot', async () => {
  const stale = new Date(Date.now() - 3600_000).toISOString();
  const h = harness('umbrelMountsLate', { graceSec: 180 }, { active: 'none', boundTo: null, graceStartedAt: stale });
  try {
    const s = defaultSettingsCoop({ graceSec: 180 });
    const res = await h.backing.evaluate(s);
    // OLD behaviour: grace already "expired" 1h ago -> direct-mount fallback.
    assert.equal(res.decision.action, 'wait', 'first post-boot tick still WAITS');
    assert.ok(res.graceRemainingSec > 170, `fresh full grace, got ${res.graceRemainingSec}`);
    assert.ok(res.graceRemainingSec <= 180);
  } finally {
    h.cleanup();
  }
});

test('F3: a FUTURE-dated persisted graceStartedAt is clamped to graceSec (no multi-day wait)', async () => {
  const future = new Date(Date.now() + 3 * 86400_000).toISOString(); // +3 days (RTC-behind)
  const h = harness('umbrelMountsLate', { graceSec: 180 }, { active: 'none', boundTo: null, graceStartedAt: future });
  try {
    const s = defaultSettingsCoop({ graceSec: 180 });
    const res = await h.backing.evaluate(s);
    assert.ok(res.graceRemainingSec <= 180, `clamped to graceSec, got ${res.graceRemainingSec}`);
    assert.ok(res.graceRemainingSec > 0);
  } finally {
    h.cleanup();
  }
});

// ===========================================================================
// F5 — never persist a direct mount the mount table doesn't corroborate.
// ===========================================================================

test('F5: doDirectMount does NOT persist active="direct" when mount lies (exit 0, no mount)', async () => {
  const h = harness('umbrelNeverMounts');
  try {
    const s = defaultSettingsCoop();
    h.adapter.setMountSilentlyFails(true); // `mount` returns 0 but registers nothing
    const { view } = await h.backing.classify(s);
    const ok = await h.backing.doDirectMount(view, s, () => {});
    assert.equal(ok, false, 'the unverifiable mount is reported as a failure');
    assert.notEqual(h.backing.getRecord().active, 'direct', 'a false "direct" backing is never persisted');
  } finally {
    h.cleanup();
  }
});

// ===========================================================================
// F8 — reap matches the drive's real FS label, not the mount-point basename.
// ===========================================================================

test('F8: reap uses settings.driveLabel so drift dirs for a differently-labeled drive are reaped', async () => {
  // Label differs from the mount-point basename ("wdexternal"). A drift dir named
  // after the real label must still be reaped; the OLD basename-derived label
  // would miss it entirely.
  const h = harness('coopHealthy', { driveLabel: 'MyMedia' });
  try {
    h.adapter.addExternalDir('MyMedia (2)', false); // empty leftover for the real label
    const s = defaultSettingsCoop({ driveLabel: 'MyMedia' });
    const counts = await h.backing.reap(s);
    assert.equal(counts.dirs, 1, 'the real-label drift dir was reaped');
    assert.ok(
      !(await h.adapter.listDir(EXTERNAL_BASE))!.includes('MyMedia (2)'),
      'the "MyMedia (2)" leftover is gone',
    );
    // The unrelated live "wdexternal" umbrelOS mount is untouched.
    assert.equal(h.adapter.umbrelMountPath(), `${EXTERNAL_BASE}/wdexternal`);
  } finally {
    h.cleanup();
  }
});

function defaultSettingsCoop(overrides: Partial<Settings> = {}): Settings {
  return { ...defaultSettings(), mountMode: 'cooperative', ...overrides };
}
