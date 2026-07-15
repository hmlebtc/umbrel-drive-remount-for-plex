// Tests for the v0.2.1 recursive-removal additions on BackingEngine (spec §4) —
// the DATA-SAFETY core of this change, exercised in-memory against the coexistence
// mock:
//   * scanLeftover — bounded recursive walk (depth/node caps -> has-files),
//   * clearEmptyTree — bottom-up rmdir that removes an all-empty tree AND refuses
//     (deleting NOTHING) when a file is present, scoped strictly to the matched dir,
//   * reap — clears an empty-tree leftover, LEAVES a has-files leftover untouched,
//   * driftInfo — the reclaim flags a drifted cooperative bind exposes.
//
// Two independent guarantees are asserted directly: (1) the all-empty-dir pre-check
// and (2) rmdir-only execution (a file present -> abort, nothing deleted).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BackingEngine } from './backingEngine.js';
import { classifyLeftover } from './reap.js';
import { createMockAdapter, type MockScenario } from './mockAdapter.js';
import { defaultSettings } from './settings.js';
import type { Settings } from './types.js';

const S: Settings = defaultSettings();
const BASE = `${S.umbrelRoot}/external`;

function engineOn(scenario: MockScenario, mode: 'classic' | 'cooperative' = 'cooperative') {
  const adapter = createMockAdapter(scenario);
  const settings: Settings = { ...S, mountMode: mode };
  const backing = new BackingEngine(adapter, () => settings);
  return { adapter, backing, settings };
}

// ---------------------------------------------------------------------------
// scanLeftover — bounded recursive walk.
// ---------------------------------------------------------------------------

test('scanLeftover: an all-empty directory tree yields only dir nodes (empty-tree)', async () => {
  const { adapter, backing } = engineOn('coopHealthy');
  adapter.addExternalDir('leftover', false);
  adapter.addSubtreeNode(`${BASE}/leftover/a`, 'dir');
  adapter.addSubtreeNode(`${BASE}/leftover/a/b`, 'dir');

  const scan = await backing.scanLeftover(`${BASE}/leftover`);
  assert.ok(scan.length >= 2, 'walked the descendants');
  assert.ok(scan.every((n) => n.type === 'dir'), 'every node is a directory');
  assert.equal(classifyLeftover(scan), 'empty-tree');
});

test('scanLeftover: a file at depth yields a non-dir node (has-files)', async () => {
  const { adapter, backing } = engineOn('coopHealthy');
  adapter.addExternalDir('leftover', false);
  adapter.addSubtreeNode(`${BASE}/leftover/a/b`, 'dir');
  adapter.addSubtreeNode(`${BASE}/leftover/a/b/movie.mkv`, 'file');

  const scan = await backing.scanLeftover(`${BASE}/leftover`);
  assert.equal(classifyLeftover(scan), 'has-files');
  assert.ok(scan.some((n) => n.type === 'file'), 'the deep file appears in the scan');
});

test('scanLeftover: the DEPTH cap makes an over-deep tree classify as has-files', async () => {
  const { adapter, backing } = engineOn('coopHealthy');
  adapter.addExternalDir('deep', false);
  let p = `${BASE}/deep`;
  for (let i = 0; i < 20; i++) {
    p = `${p}/d${i}`;
    adapter.addSubtreeNode(p, 'dir');
  }
  const scan = await backing.scanLeftover(`${BASE}/deep`, { depthCap: 3 });
  assert.equal(classifyLeftover(scan), 'has-files', 'over-cap -> has-files, never auto-cleared');
});

test('scanLeftover: the NODE cap makes a huge tree classify as has-files', async () => {
  const { adapter, backing } = engineOn('coopHealthy');
  adapter.addExternalDir('wide', false);
  for (let i = 0; i < 50; i++) adapter.addSubtreeNode(`${BASE}/wide/c${i}`, 'dir');
  const scan = await backing.scanLeftover(`${BASE}/wide`, { nodeCap: 5 });
  assert.equal(classifyLeftover(scan), 'has-files', 'over-cap -> has-files, never auto-cleared');
});

// ---------------------------------------------------------------------------
// clearEmptyTree — the two data-safety guarantees.
// ---------------------------------------------------------------------------

test('clearEmptyTree: removes an all-empty directory tree bottom-up', async () => {
  const { adapter, backing } = engineOn('coopHealthy');
  adapter.addExternalDir('empty', false);
  adapter.addSubtreeNode(`${BASE}/empty/a`, 'dir');
  adapter.addSubtreeNode(`${BASE}/empty/a/b`, 'dir');

  const ok = await backing.clearEmptyTree(`${BASE}/empty`);
  assert.equal(ok, true);
  assert.equal(await adapter.statType(`${BASE}/empty`), null, 'root removed');
  assert.equal(await adapter.statType(`${BASE}/empty/a`), null, 'child removed');
  assert.equal(await adapter.statType(`${BASE}/empty/a/b`), null, 'grandchild removed');
  assert.ok(!(await adapter.listDir(BASE))!.includes('empty'));
});

test('clearEmptyTree: REFUSES and deletes NOTHING when a file is present (rmdir-only)', async () => {
  const { adapter, backing } = engineOn('coopHealthy');
  adapter.addExternalDir('hasfile', false);
  adapter.addSubtreeNode(`${BASE}/hasfile/a`, 'dir');
  adapter.addSubtreeNode(`${BASE}/hasfile/a/movie.mkv`, 'file');

  const ok = await backing.clearEmptyTree(`${BASE}/hasfile`);
  assert.equal(ok, false, 'aborted');
  // The file AND every directory above it must still exist — nothing deleted.
  assert.equal(await adapter.statType(`${BASE}/hasfile/a/movie.mkv`), 'file', 'file intact');
  assert.equal(await adapter.statType(`${BASE}/hasfile/a`), 'dir', 'its dir intact');
  assert.equal(await adapter.statType(`${BASE}/hasfile`), 'dir', 'root intact');
});

test('clearEmptyTree: a symlink (to a dir) counts as a file — tree is NOT cleared', async () => {
  const { adapter, backing } = engineOn('coopHealthy');
  adapter.addExternalDir('linky', false);
  adapter.addSubtreeNode(`${BASE}/linky/a`, 'dir');
  adapter.addSubtreeNode(`${BASE}/linky/a/link`, 'symlink');

  const ok = await backing.clearEmptyTree(`${BASE}/linky`);
  assert.equal(ok, false);
  assert.equal(await adapter.statType(`${BASE}/linky/a/link`), 'symlink', 'symlink never dereferenced/removed');
  assert.equal(await adapter.statType(`${BASE}/linky`), 'dir', 'root intact');
});

test('clearEmptyTree: scope NEVER escapes the matched dir (siblings + base untouched)', async () => {
  const { adapter, backing } = engineOn('coopHealthy');
  adapter.addExternalDir('victim', false); // a sibling that must never be touched
  adapter.addSubtreeNode(`${BASE}/victim/keep`, 'dir');
  adapter.addExternalDir('target', false);
  adapter.addSubtreeNode(`${BASE}/target/a`, 'dir');

  const ok = await backing.clearEmptyTree(`${BASE}/target`);
  assert.equal(ok, true, 'the target empty tree is cleared');
  // Nothing outside <base>/target was removed: the sibling and the base itself remain.
  assert.equal(await adapter.statType(`${BASE}/victim`), 'dir', 'sibling untouched');
  assert.equal(await adapter.statType(`${BASE}/victim/keep`), 'dir', 'sibling child untouched');
  assert.equal(await adapter.statType(BASE), 'dir', 'the external base is never ascended into');
});

// ---------------------------------------------------------------------------
// reap — integrates the empty-tree clear and the has-files skip.
// ---------------------------------------------------------------------------

test('reap: an empty-tree leftover blocking the clean name is cleared (counts as a reaped dir)', async () => {
  const { adapter, backing, settings } = engineOn('driftReclaimable');
  assert.ok((await adapter.listDir(BASE))!.includes('wdexternal'), 'leftover present before reap');

  const counts = await backing.reap(settings);
  assert.equal(counts.dirs, 1, 'the empty-tree leftover was cleared');
  const after = await adapter.listDir(BASE);
  assert.ok(!after!.includes('wdexternal'), 'leftover cleared — clean name freed');
  assert.ok(after!.includes('wdexternal (2)'), 'umbreld live (2) mount left intact');
});

test('reap: a has-files leftover is LEFT untouched (nothing cleared, file intact)', async () => {
  const { adapter, backing, settings } = engineOn('driftHasFiles');
  const counts = await backing.reap(settings);
  assert.equal(counts.dirs, 0, 'nothing cleared — the leftover contains files');
  assert.ok((await adapter.listDir(BASE))!.includes('wdexternal'), 'has-files leftover left intact');
  assert.equal(
    await adapter.statType(`${BASE}/wdexternal/skeleton/movie.mkv`),
    'file',
    'the file at depth is untouched',
  );
});

// ---------------------------------------------------------------------------
// driftInfo — the reclaim flags exposed to the switch runner + status.
// ---------------------------------------------------------------------------

async function bindTo(scenario: MockScenario) {
  const h = engineOn(scenario);
  const { view } = await h.backing.classify(h.settings);
  assert.ok(view.umbrelMount.path, 'a drifted umbrelMount is present');
  await h.backing.doBind(view.umbrelMount.path!, view, h.settings, () => {});
  return h;
}

test('driftInfo: a cooperative bind to a drifted "(2)" with an empty-tree leftover -> reclaimable', async () => {
  const h = await bindTo('driftReclaimable');
  const info = await h.backing.driftInfo(h.settings);
  assert.equal(info.driftedName, true, 'bound to a "<label> (N)" name');
  assert.equal(info.cleanNameReclaimable, true, 'empty-tree leftover -> reclaimable');
  assert.equal(info.leftoverPath, null);
});

test('driftInfo: a drifted bind with a has-files leftover -> NOT reclaimable + leftoverPath', async () => {
  const h = await bindTo('driftHasFiles');
  const info = await h.backing.driftInfo(h.settings);
  assert.equal(info.driftedName, true);
  assert.equal(info.cleanNameReclaimable, false, 'has-files leftover -> not reclaimable');
  assert.equal(info.leftoverPath, `${BASE}/wdexternal`);
});

test('driftInfo: a clean, non-drifted bind reports driftedName false', async () => {
  const h = await bindTo('coopHealthy'); // umbrelMount is the clean "wdexternal"
  const info = await h.backing.driftInfo(h.settings);
  assert.equal(info.driftedName, false);
  assert.equal(info.cleanNameReclaimable, false);
});

test('driftInfo: classic mode short-circuits (no scan, never drifted)', async () => {
  const { backing, settings } = engineOn('coopHealthy', 'classic');
  const info = await backing.driftInfo(settings);
  assert.equal(info.driftedName, false);
  assert.equal(info.cleanNameReclaimable, false);
});
