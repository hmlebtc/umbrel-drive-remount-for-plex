// Tests for mounts.ts (spec section 4, section 10 frozen signatures):
//
//   export function parseProcMounts(text: string):
//     Array<{ source: string; target: string; fsType: string; options: string[] }>
//   export function findMount(
//     mounts: Array<{ source: string; target: string; fsType: string; options: string[] }>,
//     target: string,
//   ): { source: string; target: string; fsType: string; options: string[] } | null
//
// mounts.ts is owned by B1 and does not exist at the time this file was
// written (B1 builds in parallel) — this test is written strictly against
// the frozen signatures above.

import { test } from "node:test";
import assert from "node:assert/strict";

import { findMount, parseProcMounts } from "./mounts.js";
import { PROC_MOUNTS_ENTRY_COUNT, PROC_MOUNTS_SAMPLE } from "./fixtures/procMountsFixtures.js";

test("parseProcMounts: parses every line of a realistic /proc/mounts fixture", () => {
  const mounts = parseProcMounts(PROC_MOUNTS_SAMPLE);
  assert.equal(mounts.length, PROC_MOUNTS_ENTRY_COUNT);

  const root = mounts.find((m) => m.target === "/");
  assert.ok(root);
  assert.equal(root!.source, "/dev/sda1");
  assert.equal(root!.fsType, "ext4");
  assert.deepEqual(root!.options, ["rw", "relatime", "errors=remount-ro"]);
});

test("parseProcMounts: decodes octal \\040 escapes (spaces) in mount targets", () => {
  const mounts = parseProcMounts(PROC_MOUNTS_SAMPLE);
  const decoded = mounts.find((m) => m.source === "/dev/sdc1");
  assert.ok(decoded, "expected the vfat entry with an escaped target");
  assert.equal(decoded!.target, "/media/My External Drive");
  assert.ok(!decoded!.target.includes("\\040"), "escape sequence must be decoded, not left raw");
  assert.equal(decoded!.fsType, "vfat");
});

test("parseProcMounts: overlay/tmpfs/proc pseudo-filesystems still parse into 4 fields", () => {
  const mounts = parseProcMounts(PROC_MOUNTS_SAMPLE);
  const overlay = mounts.find((m) => m.fsType === "overlay");
  assert.ok(overlay);
  assert.equal(overlay!.target, "/var/lib/docker/overlay2/abc123def/merged");
  assert.ok(overlay!.options.includes("rw"));

  const proc = mounts.find((m) => m.target === "/proc");
  assert.ok(proc);
  assert.equal(proc!.source, "proc");
  assert.equal(proc!.fsType, "proc");
});

test("findMount: duplicate targets -> returns the LAST entry (top-most/active mount)", () => {
  const mounts = parseProcMounts(PROC_MOUNTS_SAMPLE);
  const wdexternalEntries = mounts.filter((m) => m.target === "/mnt/wdexternal");
  assert.equal(wdexternalEntries.length, 2, "fixture should contain a duplicate target");

  const found = findMount(mounts, "/mnt/wdexternal");
  assert.ok(found);
  // The last (bottom-most) entry in the fixture is the rw one -> active mount.
  assert.equal(found!.source, "/dev/sdb1");
  assert.ok(found!.options.includes("rw"));
  assert.ok(!found!.options.includes("ro"));
  assert.deepEqual(found, wdexternalEntries[wdexternalEntries.length - 1]);
});

test("findMount: rw vs ro option detection", () => {
  const mounts = parseProcMounts(PROC_MOUNTS_SAMPLE);

  const ro = findMount(mounts, "/mnt/readonlydrive");
  assert.ok(ro);
  assert.ok(ro!.options.includes("ro"));
  assert.ok(!ro!.options.includes("rw"));

  const rw = findMount(mounts, "/");
  assert.ok(rw);
  assert.ok(rw!.options.includes("rw"));
  assert.ok(!rw!.options.includes("ro"));
});

test("findMount: returns null for a target that is not mounted", () => {
  const mounts = parseProcMounts(PROC_MOUNTS_SAMPLE);
  assert.equal(findMount(mounts, "/mnt/does-not-exist"), null);
});

test("parseProcMounts: empty input yields an empty array", () => {
  assert.deepEqual(parseProcMounts(""), []);
});
