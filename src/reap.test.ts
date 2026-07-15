// Tests for reap.ts (spec section 4: reaping & hygiene under <externalBase>).
//
//   export function reapPlan(
//     listing: { name; empty; mounted; source; sourcePresent }[],
//     label: string,
//   ): { rmdirs: string[]; lazyUmounts: string[] };
//
// Spec §4 rules the plan must encode, and NOTHING beyond:
//   * Only names matching the sanitized label EXACTLY, or "<label> (N)".
//   * rmdir EMPTY dirs with NO mount (the leftover-dir case).
//   * `umount -l` ZOMBIE mounts (F1: SOURCE DEVICE ABSENT), THEN rmdir the empty dir.
//   * NEVER touch: non-empty dirs, foreign labels, or LIVE mounts (F1: source
//     device present — foreign, ours, OR ours under a transient EIO).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyLeftover, reapPlan, type LeafScan, type ReapEntry } from './reap.js';

// The `dead` shorthand maps to F1's source-presence fact: a "dead" mount is one
// whose SOURCE DEVICE is gone (sourcePresent:false); a live mount keeps its
// source present (sourcePresent:true).
type Entry = { name: string; empty: boolean; mounted: boolean; dead: boolean };

function entry(name: string, o: Partial<Entry> = {}): ReapEntry {
  const e = { name, empty: false, mounted: false, dead: false, ...o };
  return {
    name: e.name,
    empty: e.empty,
    mounted: e.mounted,
    source: e.mounted ? '/dev/sdX1' : null,
    sourcePresent: e.mounted ? !e.dead : false,
  };
}

const LABEL = 'wdexternal';

test('reapPlan: an empty, unmounted, label-matched dir is scheduled for rmdir only', () => {
  const plan = reapPlan([entry('wdexternal', { empty: true })], LABEL);
  assert.deepEqual(plan.rmdirs, ['wdexternal']);
  assert.deepEqual(plan.lazyUmounts, []);
});

test('reapPlan: a "<label> (N)" leftover matches and is reaped', () => {
  const plan = reapPlan(
    [entry('wdexternal (2)', { empty: true }), entry('wdexternal (10)', { empty: true })],
    LABEL,
  );
  assert.deepEqual(plan.rmdirs.sort(), ['wdexternal (10)', 'wdexternal (2)']);
  assert.deepEqual(plan.lazyUmounts, []);
});

test('reapPlan: a DEAD mount is lazy-umounted THEN rmdir-ed', () => {
  const plan = reapPlan([entry('wdexternal (3)', { mounted: true, dead: true, empty: false })], LABEL);
  assert.deepEqual(plan.lazyUmounts, ['wdexternal (3)']);
  assert.deepEqual(plan.rmdirs, ['wdexternal (3)']);
});

test('reapPlan: a LIVE (non-dead) mount is NEVER touched — even if label-matched', () => {
  const plan = reapPlan([entry('wdexternal', { mounted: true, dead: false, empty: false })], LABEL);
  assert.deepEqual(plan.rmdirs, []);
  assert.deepEqual(plan.lazyUmounts, []);
});

test('reapPlan: a foreign label is NEVER touched (even empty/dead)', () => {
  const plan = reapPlan(
    [
      entry('someones-backup', { empty: true }),
      entry('other-drive', { mounted: true, dead: true }),
      entry('wdexternalX', { empty: true }), // not an exact match / not "<label> (N)"
      entry('wdexternal-2', { empty: true }), // wrong drift format
    ],
    LABEL,
  );
  assert.deepEqual(plan.rmdirs, []);
  assert.deepEqual(plan.lazyUmounts, []);
});

test('reapPlan: a NON-EMPTY unmounted dir (has real files) is NEVER rmdir-ed', () => {
  const plan = reapPlan([entry('wdexternal', { empty: false, mounted: false, dead: false })], LABEL);
  assert.deepEqual(plan.rmdirs, []);
  assert.deepEqual(plan.lazyUmounts, []);
});

test('reapPlan: the "(N)" match is exact — no leading/trailing junk, digits only', () => {
  const plan = reapPlan(
    [
      entry('wdexternal (2) ', { empty: true }), // trailing space
      entry(' wdexternal (2)', { empty: true }), // leading space
      entry('wdexternal (2x)', { empty: true }), // non-digit
      entry('wdexternal ()', { empty: true }), // empty index
      entry('wdexternal (2)', { empty: true }), // the one true match
    ],
    LABEL,
  );
  assert.deepEqual(plan.rmdirs, ['wdexternal (2)']);
});

test('reapPlan: a realistic mixed listing reaps exactly the right names', () => {
  const plan = reapPlan(
    [
      entry('wdexternal', { empty: true }), // leftover -> rmdir
      entry('wdexternal (2)', { mounted: true, dead: false }), // umbreld LIVE mount -> skip
      entry('wdexternal (3)', { mounted: true, dead: true }), // dead -> umount + rmdir
      entry('someones-backup', { empty: true }), // foreign -> skip
      entry('wdexternal (4)', { empty: false }), // non-empty ours -> skip
    ],
    LABEL,
  );
  assert.deepEqual(plan.rmdirs.sort(), ['wdexternal', 'wdexternal (3)']);
  assert.deepEqual(plan.lazyUmounts, ['wdexternal (3)']);
});

test('reapPlan: empty listing -> empty plan', () => {
  const plan = reapPlan([], LABEL);
  assert.deepEqual(plan.rmdirs, []);
  assert.deepEqual(plan.lazyUmounts, []);
});

// ===========================================================================
// F1 regression (data safety): a MOUNTED dir is reapable ONLY when its source
// device is ABSENT. A live source — foreign, ours, or ours under transient EIO —
// is NEVER torn down. The OLD rule (reap when the target was merely unreadable)
// would umount a live foreign/own mount on a passing EIO; these encode that dead.
// ===========================================================================

test('F1: a foreign identically-labeled LIVE mount (source present) is NEVER reaped', () => {
  const plan = reapPlan(
    [{ name: 'wdexternal', empty: false, mounted: true, source: '/dev/sdz1', sourcePresent: true }],
    LABEL,
  );
  assert.deepEqual(plan.lazyUmounts, [], 'a live source must never be unmounted');
  assert.deepEqual(plan.rmdirs, []);
});

test('F1: OUR live mount under a transient EIO (unreadable but source PRESENT) is NEVER reaped', () => {
  // The proven exploit: an EIO made the target unlistable. The OLD deadness rule
  // (mounted && contents===null) would tear this LIVE mount down. Source-present
  // gating leaves it untouched.
  const plan = reapPlan(
    [{ name: 'wdexternal', empty: false, mounted: true, source: '/dev/sda1', sourcePresent: true }],
    LABEL,
  );
  assert.deepEqual(plan.lazyUmounts, [], 'a transient EIO must not qualify as reapable');
  assert.deepEqual(plan.rmdirs, []);
});

test('F1: a genuine ZOMBIE (source device ABSENT) is lazy-umounted THEN rmdir-ed', () => {
  const plan = reapPlan(
    [{ name: 'wdexternal (2)', empty: false, mounted: true, source: '/dev/sda1', sourcePresent: false }],
    LABEL,
  );
  assert.deepEqual(plan.lazyUmounts, ['wdexternal (2)']);
  assert.deepEqual(plan.rmdirs, ['wdexternal (2)']);
});

test('F1: an empty, unmounted, label-matched dir is rmdir-only (never umounted)', () => {
  const plan = reapPlan(
    [{ name: 'wdexternal', empty: true, mounted: false, source: null, sourcePresent: false }],
    LABEL,
  );
  assert.deepEqual(plan.lazyUmounts, []);
  assert.deepEqual(plan.rmdirs, ['wdexternal']);
});

// ===========================================================================
// classifyLeftover (spec §4, v0.2.1 — DATA SAFETY): a leftover subtree is only
// 'empty-tree' (safe to clear) when EVERY node is a directory. A single file /
// symlink / socket / device ANYWHERE makes it 'has-files' (never touched). An
// over-cap scan is expressed by a non-dir sentinel node, so it too is has-files.
// ===========================================================================

const B = '/home/umbrel/umbrel/external/wdexternal';

test('classifyLeftover: an all-empty directory tree is empty-tree', () => {
  const scan: LeafScan = [
    { path: `${B}/skeleton`, type: 'dir' },
    { path: `${B}/skeleton/nested`, type: 'dir' },
    { path: `${B}/another`, type: 'dir' },
  ];
  assert.equal(classifyLeftover(scan), 'empty-tree');
});

test('classifyLeftover: an empty scan (no descendants) is empty-tree', () => {
  assert.equal(classifyLeftover([]), 'empty-tree');
});

test('classifyLeftover: a FILE at any depth makes the tree has-files', () => {
  const scan: LeafScan = [
    { path: `${B}/skeleton`, type: 'dir' },
    { path: `${B}/skeleton/deep`, type: 'dir' },
    { path: `${B}/skeleton/deep/movie.mkv`, type: 'file' }, // one file, deep
  ];
  assert.equal(classifyLeftover(scan), 'has-files');
});

test('classifyLeftover: a SYMLINK at any depth makes the tree has-files (never dereferenced)', () => {
  const scan: LeafScan = [
    { path: `${B}/skeleton`, type: 'dir' },
    { path: `${B}/skeleton/link`, type: 'symlink' }, // a symlink is NOT an empty dir
  ];
  assert.equal(classifyLeftover(scan), 'has-files');
});

test('classifyLeftover: an "other" node (socket/device/fifo) makes the tree has-files', () => {
  const scan: LeafScan = [
    { path: `${B}/dev-node`, type: 'other' },
  ];
  assert.equal(classifyLeftover(scan), 'has-files');
});

test('classifyLeftover: an over-cap sentinel (non-dir node) classifies as has-files', () => {
  // scanLeftover appends a non-directory sentinel when it hits the depth/node cap
  // (it could not fully prove the tree empty), so classifyLeftover leaves it alone.
  const scan: LeafScan = [
    { path: `${B}/a`, type: 'dir' },
    { path: `${B}/a`, type: 'other' }, // the cap sentinel
  ];
  assert.equal(classifyLeftover(scan), 'has-files');
});
