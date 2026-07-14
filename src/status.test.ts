// Tests for the shared stale-mount helper (fix #6). computeStale is the ONE
// helper used by both status.ts (probeStatus) and restore.ts (ensureMount) so
// they agree on what "stale" means, now including the EIO (target-unreadable)
// probe.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeStale, probeMountReadable, probeStatus } from "./status.js";
import { createMockAdapter, type MockScenario } from "./mockAdapter.js";
import { BackingEngine } from "./backingEngine.js";
import { defaultSettings } from "./settings.js";
import type { BackingRecord, Settings } from "./types.js";

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

// ===========================================================================
// status.warnings (spec section 8). FORMAT_DIALOG_EXPECTED in classic mode is
// the core case; EJECTED_IN_UMBREL / WAITING_FOR_UMBREL_MOUNT come from the
// cooperative engine.
// ===========================================================================

function coopSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...defaultSettings(), mountMode: "cooperative", ...overrides };
}

function coopEngine(scenario: MockScenario, seed?: Partial<BackingRecord>) {
  const dir = mkdtempSync(join(tmpdir(), "drp-backing-"));
  if (seed) {
    const rec: BackingRecord = {
      mode: "cooperative",
      active: "none",
      boundTo: null,
      bindGeneration: 0,
      lastBindChangeAt: null,
      graceStartedAt: null,
      ...seed,
    };
    writeFileSync(join(dir, "backing.json"), JSON.stringify(rec), "utf8");
  }
  const settings = coopSettings();
  const adapter = createMockAdapter(scenario);
  const engine = new BackingEngine(adapter, () => settings, undefined, dir);
  return { engine, settings, adapter, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("warnings: classic mode with the drive mounted -> FORMAT_DIALOG_EXPECTED", async () => {
  // defaultSettings() is classic; the 'healthy' mock is a direct mount that holds
  // the raw device (blocking umbreld) -> Files would offer to Format the drive.
  const status = await probeStatus(createMockAdapter("healthy"), defaultSettings());
  assert.ok(status.warnings.includes("FORMAT_DIALOG_EXPECTED"), `warnings=${JSON.stringify(status.warnings)}`);
});

test("warnings: classic mode with nothing mounted -> no FORMAT_DIALOG_EXPECTED", async () => {
  const status = await probeStatus(createMockAdapter("notMounted"), defaultSettings());
  assert.ok(!status.warnings.includes("FORMAT_DIALOG_EXPECTED"));
});

test("warnings: cooperative healthy bind -> active umbrel-bind, no Format warning", async () => {
  const h = coopEngine("coopHealthy", { active: "umbrel-bind", boundTo: "/home/umbrel/umbrel/external/wdexternal" });
  try {
    const { backing, warnings } = await h.engine.backingStatus(h.settings);
    assert.equal(backing.active, "umbrel-bind");
    assert.equal(backing.umbrelMount.found, true);
    assert.equal(backing.umbrelMount.readable, true);
    assert.ok(!warnings.includes("FORMAT_DIALOG_EXPECTED"), "a healthy cooperative bind must NOT warn about Format");
  } finally {
    h.cleanup();
  }
});

test("warnings: an eject in umbrelOS (drive present, umbrelMount gone) -> EJECTED_IN_UMBREL", async () => {
  // After a release the record keeps boundTo as an ejected marker (active "none").
  const h = coopEngine("ejectedInUmbrel", { active: "none", boundTo: "/home/umbrel/umbrel/external/wdexternal" });
  try {
    const { warnings } = await h.engine.backingStatus(h.settings);
    assert.ok(warnings.includes("EJECTED_IN_UMBREL"), `warnings=${JSON.stringify(warnings)}`);
  } finally {
    h.cleanup();
  }
});

test("warnings: cooperative, umbrel not mounted yet, grace counting -> WAITING_FOR_UMBREL_MOUNT", async () => {
  const h = coopEngine("umbrelMountsLate");
  try {
    await h.engine.evaluate(h.settings); // starts the boot grace window
    const { warnings } = await h.engine.backingStatus(h.settings);
    assert.ok(warnings.includes("WAITING_FOR_UMBREL_MOUNT"), `warnings=${JSON.stringify(warnings)}`);
  } finally {
    h.cleanup();
  }
});
