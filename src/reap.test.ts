// Tests for reap.ts (spec section 4: reaping & hygiene under <externalBase>).
// reap.ts is B1's file, built in parallel; written against the FROZEN signature:
//
//   export function reapPlan(
//     listing: { name: string; empty: boolean; mounted: boolean; dead: boolean }[],
//     label: string,
//   ): { rmdirs: string[]; lazyUmounts: string[] };
//
// Spec §4 rules the plan must encode, and NOTHING beyond:
//   * Only names matching the sanitized label EXACTLY, or "<label> (N)".
//   * rmdir EMPTY dirs with NO mount (the leftover-dir case).
//   * `umount -l` DEAD mounts of our former device, THEN rmdir the now-empty dir.
//   * NEVER touch: non-empty dirs, foreign labels, or LIVE mounts that are not
//     dead (e.g. umbreld's current /External mount).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reapPlan } from './reap.js';

type Entry = { name: string; empty: boolean; mounted: boolean; dead: boolean };

function entry(name: string, o: Partial<Entry> = {}): Entry {
  return { name, empty: false, mounted: false, dead: false, ...o };
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
