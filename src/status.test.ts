// Tests for the shared stale-mount helper (fix #6). computeStale is the ONE
// helper used by both status.ts (probeStatus) and restore.ts (ensureMount) so
// they agree on what "stale" means, now including the EIO (target-unreadable)
// probe.

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeStale, probeMountReadable } from "./status.js";
import { createMockAdapter } from "./mockAdapter.js";

const DEV = "/dev/sdb1";

test("computeStale: not mounted -> never stale", () => {
  assert.equal(computeStale(false, true, DEV, DEV, true), false);
  assert.equal(computeStale(false, false, null, "", false), false);
});

test("computeStale: mounted but by-uuid device gone (drive detached) -> stale", () => {
  assert.equal(computeStale(true, false, null, DEV, true), true);
});

test("computeStale: mounted, device matches, but target unreadable (EIO) -> stale", () => {
  // This is the new branch: even when source === device, an unreadable target
  // (I/O error on a live mount whose backing device was yanked) is stale.
  assert.equal(computeStale(true, true, DEV, DEV, false), true);
});

test("computeStale: mounted, device matches, target readable -> healthy (not stale)", () => {
  assert.equal(computeStale(true, true, DEV, DEV, true), false);
});

test("computeStale: mounted, backing device no longer matches live device -> stale", () => {
  assert.equal(computeStale(true, true, DEV, "/dev/sda1", true), true);
});

test("probeMountReadable: a healthy mock mount lists its target (readable)", async () => {
  const adapter = createMockAdapter("healthy");
  assert.equal(await probeMountReadable(adapter, "/mnt/wdexternal"), true);
});

test("probeMountReadable: a stale mock mount cannot list its target (unreadable)", async () => {
  const adapter = createMockAdapter("mountStale");
  assert.equal(await probeMountReadable(adapter, "/mnt/wdexternal"), false);
});
