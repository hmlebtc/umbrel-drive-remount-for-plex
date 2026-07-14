// Tests for backing.ts (spec sections 1-4). backing.ts is B1's file, built in
// parallel; these tests are written strictly against the FROZEN signatures and
// the ACTUAL types now locked in types.ts (BackingView, MountInfoEntry,
// BackingRecord, BackingAction):
//
//   export function parseMountInfo(text: string): MountInfoEntry[];
//   export function classifyBacking(
//     entries: MountInfoEntry[],
//     opts: { device: string | null; mountPoint: string; externalBase: string; record: BackingRecord | null },
//   ): BackingView;
//   export function backingDecide(
//     view: BackingView,
//     ctx: { mode: MountMode; drivePresent: boolean; graceRemainingSec: number; plexRunning: boolean; sinceLastHandoverSec: number },
//   ): BackingDecision;
//
// INFERRED SEMANTICS (integration agent: reconcile against B1's backing.ts —
// the assertions encode the spec; only field-mapping should ever need a tweak):
//   * classifyBacking.umbrelMount = the newest /External fs-root mount of `device`
//     (mountpoint under externalBase, root "/"); newest mountId wins (§2).
//   * The engine layers the live READABILITY probe onto umbrelMount.found BEFORE
//     backingDecide (per the BackingView doc-comment): so in backingDecide,
//     `view.umbrelMount.found` means "found AND readable / usable".
//   * stablePath.stale := the /mnt/wdexternal mount's source is not the live
//     device (renumbered / gone). direct vs bindOfUmbrel come from the record.
//     boundElsewhere := recorded umbrel-bind whose boundTo is not the live
//     umbrelMount path.
//   * backingDecide handover (ladder D) is gated on a SAFE POINT (Plex not
//     running) AND a cooldown (sinceLastHandoverSec elapsed) — "one attempt per
//     cooldown" (§3). The exact cooldown constant is B1's; tests use extreme
//     values (99999 vs 0) so only the branch, not the constant, is asserted.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { backingDecide, classifyBacking, parseMountInfo } from './backing.js';
import { byUuidPath } from './paths.js';
import { defaultSettings } from './settings.js';
import { createMockAdapter, type MockScenario } from './mockAdapter.js';
import type { BackingRecord, BackingView, MountInfoEntry } from './types.js';
import {
  MI_COOP_HEALTHY,
  MI_DIRECT_ONLY,
  MI_EJECTED,
  MI_NOTHING,
  MI_PATH_DRIFT,
  MI_STALE_AFTER_REPLUG,
  MI_TWO_UMBREL_MOUNTS,
  PROC_MOUNTINFO_ENTRY_COUNT,
  PROC_MOUNTINFO_SAMPLE,
} from './fixtures/mountInfoFixtures.js';

const EXTERNAL_BASE = '/home/umbrel/umbrel/external';
const MOUNT_POINT = '/mnt/wdexternal';

function record(overrides: Partial<BackingRecord> = {}): BackingRecord {
  return {
    mode: 'cooperative',
    active: 'none',
    boundTo: null,
    bindGeneration: 0,
    lastBindChangeAt: null,
    graceStartedAt: null,
    ...overrides,
  };
}

function classify(
  text: string,
  opts: { device?: string | null; record?: BackingRecord | null } = {},
): BackingView {
  return classifyBacking(parseMountInfo(text), {
    device: opts.device === undefined ? '/dev/sda1' : opts.device,
    mountPoint: MOUNT_POINT,
    externalBase: EXTERNAL_BASE,
    record: opts.record ?? null,
  });
}

// ===========================================================================
// parseMountInfo — realistic fixture with octal escapes + variable optionals.
// ===========================================================================

test('parseMountInfo: parses every line of a realistic mountinfo fixture', () => {
  const entries = parseMountInfo(PROC_MOUNTINFO_SAMPLE);
  assert.equal(entries.length, PROC_MOUNTINFO_ENTRY_COUNT);
});

test('parseMountInfo: the root filesystem entry decodes all fixed fields', () => {
  const e = parseMountInfo(PROC_MOUNTINFO_SAMPLE).find((m) => m.mountpoint === '/')!;
  assert.ok(e);
  assert.equal(e.mountId, 24);
  assert.equal(e.parentId, 1);
  assert.equal(e.root, '/');
  assert.deepEqual(e.options, ['rw', 'relatime']);
  assert.equal(e.fsType, 'ext4');
  assert.equal(e.source, '/dev/sda2');
  assert.deepEqual(e.superOptions, ['rw', 'errors=remount-ro']);
});

test('parseMountInfo: an entry with ZERO optional fields parses (straight to "-")', () => {
  const e = parseMountInfo(PROC_MOUNTINFO_SAMPLE).find((m) => m.mountpoint === '/proc')!;
  assert.ok(e);
  assert.equal(e.mountId, 22);
  assert.equal(e.fsType, 'proc');
  assert.equal(e.source, 'proc');
  assert.deepEqual(e.superOptions, ['rw']);
});

test('parseMountInfo: an entry with SEVERAL optional fields discards them (finds the "-")', () => {
  const e = parseMountInfo(PROC_MOUNTINFO_SAMPLE).find((m) => m.mountId === 101)!;
  assert.ok(e, 'expected the umbrelOS /External entry with two optional fields');
  assert.equal(e.mountpoint, '/home/umbrel/umbrel/external/wdexternal');
  assert.equal(e.root, '/');
  assert.equal(e.fsType, 'ext4');
  assert.equal(e.source, '/dev/sda1');
  assert.deepEqual(e.superOptions, ['rw']);
  // shared:1 / master:2 must NOT have leaked into any retained field.
  assert.ok(!e.options.includes('shared:1'));
  assert.ok(!e.superOptions.includes('master:2'));
});

test('parseMountInfo: decodes octal \\040 escapes in the MOUNTPOINT field', () => {
  const e = parseMountInfo(PROC_MOUNTINFO_SAMPLE).find((m) => m.source === '/dev/sdc1')!;
  assert.ok(e);
  assert.equal(e.mountpoint, '/media/My External Drive');
  assert.ok(!e.mountpoint.includes('\\040'));
});

test('parseMountInfo: decodes octal \\040 escapes in the ROOT field', () => {
  const e = parseMountInfo(PROC_MOUNTINFO_SAMPLE).find((m) => m.mountId === 120)!;
  assert.ok(e);
  assert.equal(e.root, '/Movies HD');
  assert.equal(e.mountpoint, '/srv/pub');
});

test('parseMountInfo: multi-value superOptions (overlay) split on commas', () => {
  const e = parseMountInfo(PROC_MOUNTINFO_SAMPLE).find((m) => m.fsType === 'overlay')!;
  assert.ok(e);
  assert.equal(e.source, 'overlay');
  assert.ok(e.superOptions.includes('lowerdir=/a:/b'));
  assert.ok(e.superOptions.includes('workdir=/d'));
});

test('parseMountInfo: empty input yields an empty array', () => {
  assert.deepEqual(parseMountInfo(''), []);
});

// ===========================================================================
// classifyBacking — umbrel mount, drift, dead mounts, record reconciliation.
// ===========================================================================

test('classifyBacking: coop-healthy — umbrelMount found + our bind recognised', () => {
  const v = classify(MI_COOP_HEALTHY, {
    record: record({ active: 'umbrel-bind', boundTo: `${EXTERNAL_BASE}/wdexternal` }),
  });
  assert.equal(v.umbrelMount.found, true);
  assert.equal(v.umbrelMount.path, `${EXTERNAL_BASE}/wdexternal`);
  assert.equal(v.umbrelMount.source, '/dev/sda1');
  assert.equal(v.stablePath.mounted, true);
  assert.equal(v.stablePath.source, '/dev/sda1');
  assert.equal(v.stablePath.stale, false);
  assert.equal(v.stablePath.bindOfUmbrel, true);
  assert.equal(v.stablePath.boundElsewhere, false);
});

test('classifyBacking: umbrelMount path DRIFT ("wdexternal (2)") is detected verbatim', () => {
  const v = classify(MI_PATH_DRIFT, { record: record() });
  assert.equal(v.umbrelMount.found, true);
  assert.equal(v.umbrelMount.path, `${EXTERNAL_BASE}/wdexternal (2)`);
  assert.equal(v.stablePath.mounted, false);
});

test('classifyBacking: with two /External mounts, the NEWEST mountId wins (§2)', () => {
  const v = classify(MI_TWO_UMBREL_MOUNTS, { record: record() });
  assert.equal(v.umbrelMount.found, true);
  assert.equal(v.umbrelMount.mountId, 205);
  assert.equal(v.umbrelMount.path, `${EXTERNAL_BASE}/wdexternal (2)`);
});

test('classifyBacking: classic direct mount — no umbrelMount, stablePath.direct', () => {
  const v = classify(MI_DIRECT_ONLY, { record: record({ active: 'direct' }) });
  assert.equal(v.umbrelMount.found, false);
  assert.equal(v.umbrelMount.path, null);
  assert.equal(v.stablePath.mounted, true);
  assert.equal(v.stablePath.direct, true);
  assert.equal(v.stablePath.stale, false);
});

test('classifyBacking: renumbered device — stable-path bind is STALE, umbrelMount is the live one', () => {
  const v = classify(MI_STALE_AFTER_REPLUG, {
    device: '/dev/sdb1', // the drive came back as sdb1
    record: record({ active: 'umbrel-bind', boundTo: `${EXTERNAL_BASE}/wdexternal` }),
  });
  // The live umbrelMount is the one on the live device (sdb1), drifted to "(2)".
  assert.equal(v.umbrelMount.found, true);
  assert.equal(v.umbrelMount.source, '/dev/sdb1');
  assert.equal(v.umbrelMount.path, `${EXTERNAL_BASE}/wdexternal (2)`);
  // Our /mnt/wdexternal bind still references the dead /dev/sda1.
  assert.equal(v.stablePath.mounted, true);
  assert.equal(v.stablePath.source, '/dev/sda1');
  assert.equal(v.stablePath.stale, true);
  // Recorded boundTo is no longer the live umbrelMount path.
  assert.equal(v.stablePath.boundElsewhere, true);
});

test('classifyBacking: ejected-in-umbrel — no umbrelMount though the drive is present', () => {
  const v = classify(MI_EJECTED, {
    device: '/dev/sda1',
    record: record({ active: 'umbrel-bind', boundTo: `${EXTERNAL_BASE}/wdexternal` }),
  });
  assert.equal(v.umbrelMount.found, false);
  assert.equal(v.stablePath.mounted, true);
  assert.equal(v.stablePath.source, '/dev/sda1');
});

test('classifyBacking: nothing mounted — clean empty view, record echoed', () => {
  const rec = record({ graceStartedAt: '2026-07-14T00:00:00.000Z' });
  const v = classify(MI_NOTHING, { record: rec });
  assert.equal(v.umbrelMount.found, false);
  assert.equal(v.stablePath.mounted, false);
  assert.deepEqual(v.record, rec);
});

// ===========================================================================
// classifyBacking driven off the MOCK's synthesized mountinfo (proves the
// coexistence simulation feeds the classifier the states the ladder expects).
// ===========================================================================

async function classifyMock(scenario: MockScenario, rec: BackingRecord | null): Promise<BackingView> {
  const a = createMockAdapter(scenario);
  const s = defaultSettings();
  const device = await a.realpath(byUuidPath(s));
  return classifyBacking(parseMountInfo(await a.readProcMountInfo()), {
    device,
    mountPoint: s.mountPoint,
    externalBase: `${s.umbrelRoot}/external`,
    record: rec,
  });
}

test('mock+classify: coopHealthy yields a found umbrelMount and a live bind', async () => {
  const v = await classifyMock('coopHealthy', record({ active: 'umbrel-bind', boundTo: `${EXTERNAL_BASE}/wdexternal` }));
  assert.equal(v.umbrelMount.found, true);
  assert.equal(v.umbrelMount.path, `${EXTERNAL_BASE}/wdexternal`);
  assert.equal(v.stablePath.mounted, true);
  assert.equal(v.stablePath.stale, false);
});

test('mock+classify: umbrelPathDrift yields umbrelMount at the "(2)" path', async () => {
  const v = await classifyMock('umbrelPathDrift', record());
  assert.equal(v.umbrelMount.found, true);
  assert.equal(v.umbrelMount.path, `${EXTERNAL_BASE}/wdexternal (2)`);
});

test('mock+classify: ejectedInUmbrel yields no umbrelMount while the drive is present', async () => {
  const v = await classifyMock('ejectedInUmbrel', record({ active: 'umbrel-bind', boundTo: `${EXTERNAL_BASE}/wdexternal` }));
  assert.equal(v.umbrelMount.found, false);
});

test('mock+classify: bindStaleAfterReplug yields a live umbrelMount on the new device + a stale stable path', async () => {
  const v = await classifyMock('bindStaleAfterReplug', record({ active: 'umbrel-bind', boundTo: `${EXTERNAL_BASE}/wdexternal` }));
  assert.equal(v.umbrelMount.found, true);
  assert.equal(v.umbrelMount.source, '/dev/sdb1');
  assert.equal(v.stablePath.mounted, true);
  assert.equal(v.stablePath.stale, true);
});

// ===========================================================================
// backingDecide — FULL decision table (every ladder branch + every action).
// ===========================================================================

function view(overrides: {
  umbrelMount?: Partial<BackingView['umbrelMount']>;
  stablePath?: Partial<BackingView['stablePath']>;
  record?: BackingRecord | null;
} = {}): BackingView {
  return {
    umbrelMount: { found: false, path: null, mountId: null, source: null, ...overrides.umbrelMount },
    stablePath: {
      mounted: false,
      source: '',
      root: '',
      direct: false,
      bindOfUmbrel: false,
      boundElsewhere: false,
      stale: false,
      ...overrides.stablePath,
    },
    record: overrides.record ?? null,
  };
}

function ctx(overrides: Partial<{
  mode: 'classic' | 'cooperative';
  drivePresent: boolean;
  graceRemainingSec: number;
  plexRunning: boolean;
  sinceLastHandoverSec: number;
}> = {}) {
  return {
    mode: 'cooperative' as const,
    drivePresent: true,
    graceRemainingSec: 0,
    plexRunning: true,
    sinceLastHandoverSec: 99999,
    ...overrides,
  };
}

function assertAction(d: { action: string; reason: string }, expected: string): void {
  assert.equal(d.action, expected, `expected "${expected}", got "${d.action}" (reason: ${d.reason})`);
  assert.equal(typeof d.reason, 'string');
  assert.ok(d.reason.length > 0, 'reason must be a non-empty explanation');
}

test('backingDecide: drive absent -> none (short-circuit)', () => {
  const v = view({ umbrelMount: { found: true, path: `${EXTERNAL_BASE}/wdexternal` } });
  assertAction(backingDecide(v, ctx({ drivePresent: false })), 'none');
});

test('backingDecide: classic mode + healthy direct mount -> none', () => {
  const v = view({ stablePath: { mounted: true, source: '/dev/sda1', direct: true, stale: false } });
  assertAction(backingDecide(v, ctx({ mode: 'classic' })), 'none');
});

test('backingDecide: classic mode + nothing mounted -> direct-mount (v0.1.x intent)', () => {
  const v = view();
  assertAction(backingDecide(v, ctx({ mode: 'classic' })), 'direct-mount');
});

test('backingDecide: classic mode + drive absent -> none', () => {
  assertAction(backingDecide(view(), ctx({ mode: 'classic', drivePresent: false })), 'none');
});

test('backingDecide [A]: umbrelMount found + already correctly bound -> none', () => {
  const v = view({
    umbrelMount: { found: true, path: `${EXTERNAL_BASE}/wdexternal`, source: '/dev/sda1' },
    stablePath: { mounted: true, source: '/dev/sda1', bindOfUmbrel: true, boundElsewhere: false, stale: false },
    record: record({ active: 'umbrel-bind', boundTo: `${EXTERNAL_BASE}/wdexternal` }),
  });
  assertAction(backingDecide(v, ctx()), 'none');
});

test('backingDecide [A]: umbrelMount found + nothing at the stable path -> bind', () => {
  const v = view({ umbrelMount: { found: true, path: `${EXTERNAL_BASE}/wdexternal`, source: '/dev/sda1' } });
  assertAction(backingDecide(v, ctx()), 'bind');
});

test('backingDecide [A]: umbrelMount found + our bind points ELSEWHERE (drift) -> bind (rebind)', () => {
  const v = view({
    umbrelMount: { found: true, path: `${EXTERNAL_BASE}/wdexternal (2)`, source: '/dev/sda1' },
    stablePath: { mounted: true, source: '/dev/sda1', bindOfUmbrel: true, boundElsewhere: true, stale: false },
    record: record({ active: 'umbrel-bind', boundTo: `${EXTERNAL_BASE}/wdexternal` }),
  });
  assertAction(backingDecide(v, ctx()), 'bind');
});

test('backingDecide [A]: umbrelMount found + our bind is STALE -> bind (re-establish)', () => {
  const v = view({
    umbrelMount: { found: true, path: `${EXTERNAL_BASE}/wdexternal (2)`, source: '/dev/sdb1' },
    stablePath: { mounted: true, source: '/dev/sda1', bindOfUmbrel: true, boundElsewhere: true, stale: true },
    record: record({ active: 'umbrel-bind', boundTo: `${EXTERNAL_BASE}/wdexternal` }),
  });
  assertAction(backingDecide(v, ctx()), 'bind');
});

test('backingDecide [D]: umbrelMount appears while we hold DIRECT, safe point (plex down) -> handover', () => {
  const v = view({
    umbrelMount: { found: true, path: `${EXTERNAL_BASE}/wdexternal`, source: '/dev/sda1' },
    stablePath: { mounted: true, source: '/dev/sda1', direct: true },
    record: record({ active: 'direct' }),
  });
  assertAction(backingDecide(v, ctx({ plexRunning: false, sinceLastHandoverSec: 99999 })), 'handover');
});

test('backingDecide [D]: umbrelMount while DIRECT but Plex is running -> none (defer to a safe point)', () => {
  const v = view({
    umbrelMount: { found: true, path: `${EXTERNAL_BASE}/wdexternal`, source: '/dev/sda1' },
    stablePath: { mounted: true, source: '/dev/sda1', direct: true },
    record: record({ active: 'direct' }),
  });
  assertAction(backingDecide(v, ctx({ plexRunning: true, sinceLastHandoverSec: 99999 })), 'none');
});

test('backingDecide [D]: umbrelMount while DIRECT, plex down but within cooldown -> none (one attempt per cooldown)', () => {
  // ASSUMES the cooldown gate lives inside backingDecide (sinceLastHandoverSec is
  // provided to it). sinceLastHandoverSec=0 blocks under any positive cooldown.
  const v = view({
    umbrelMount: { found: true, path: `${EXTERNAL_BASE}/wdexternal`, source: '/dev/sda1' },
    stablePath: { mounted: true, source: '/dev/sda1', direct: true },
    record: record({ active: 'direct', lastBindChangeAt: '2026-07-14T00:00:00.000Z' }),
  });
  assertAction(backingDecide(v, ctx({ plexRunning: false, sinceLastHandoverSec: 0 })), 'none');
});

test('backingDecide [E]: umbrelMount gone while we hold a bind + drive present -> release (eject)', () => {
  const v = view({
    umbrelMount: { found: false },
    stablePath: { mounted: true, source: '/dev/sda1', bindOfUmbrel: true, boundElsewhere: true },
    record: record({ active: 'umbrel-bind', boundTo: `${EXTERNAL_BASE}/wdexternal` }),
  });
  assertAction(backingDecide(v, ctx({ graceRemainingSec: 0 })), 'release');
});

test('backingDecide [B]: no umbrelMount, no bind, grace still counting -> wait', () => {
  const v = view({ umbrelMount: { found: false }, record: record({ active: 'none', graceStartedAt: '2026-07-14T00:00:00.000Z' }) });
  assertAction(backingDecide(v, ctx({ graceRemainingSec: 120 })), 'wait');
});

test('backingDecide [C]: no umbrelMount after grace expiry INSIDE an arrival flow -> direct-mount', () => {
  // The classic fallback fires only when a grace window was actually started
  // (arrival flow): record.graceStartedAt != null. This is what keeps us from
  // ever classic-mounting over a user's eject.
  const v = view({
    umbrelMount: { found: false },
    record: record({ active: 'none', graceStartedAt: '2026-07-14T00:00:00.000Z' }),
  });
  assertAction(backingDecide(v, ctx({ graceRemainingSec: 0 })), 'direct-mount');
});

test('backingDecide: grace exhausted but NO arrival flow (post-eject, graceStartedAt null) -> none', () => {
  const v = view({ umbrelMount: { found: false }, record: record({ active: 'none', graceStartedAt: null }) });
  assertAction(backingDecide(v, ctx({ graceRemainingSec: 0 })), 'none');
});

test('backingDecide [C]: fallback already direct, still no umbrelMount -> none (sticky, no flap)', () => {
  const v = view({
    umbrelMount: { found: false },
    stablePath: { mounted: true, source: '/dev/sda1', direct: true },
    record: record({ active: 'direct' }),
  });
  assertAction(backingDecide(v, ctx({ graceRemainingSec: 0 })), 'none');
});
