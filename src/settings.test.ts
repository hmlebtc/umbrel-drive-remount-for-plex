// Tests for settings.ts (spec section 5 + the security hardening in fix #2):
//   - validateSettings reports errors AND reverts each failing field to its
//     default (so a hostile settings.json / DRP_* value can never reach the
//     boot-hook template or an exec argv on the load/seed/init path),
//   - loadSettings/seedSettingsFromEnv/SettingsStore-init apply that fallback,
//   - PUT (SettingsStore.update) still REJECTS invalid input (no silent revert),
//   - the UUID regex is tightened to canonical 8-4-4-4-12,
//   - folders are capped (<=64 entries, <=255 chars each).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultSettings,
  loadSettings,
  seedSettingsFromEnv,
  SettingsStore,
  validateSettings,
} from "./settings.js";
import type { Settings } from "./types.js";

function withDefaults(overrides: Partial<Settings>): Settings {
  return { ...defaultSettings(), ...overrides } as Settings;
}

// ---------------------------------------------------------------------------
// Hostile values -> reported AND reverted to default (never survive to a template).
// ---------------------------------------------------------------------------

test("validateSettings: a newline/shell-metachar mountPoint is reverted to default", () => {
  const hostile = withDefaults({ mountPoint: "/mnt/wd\n rm -rf /home/umbrel/umbrel #" });
  const { errors, resetFields, settings } = validateSettings(hostile);
  assert.ok(errors.length > 0, "must report the bad mountPoint");
  assert.ok(resetFields.includes("mountPoint"));
  assert.equal(settings.mountPoint, defaultSettings().mountPoint, "mountPoint must fall back to default");
  assert.ok(!settings.mountPoint.includes("\n"));
});

test("seedSettingsFromEnv: a command-substitution DRP_MOUNT_POINT is neutralised", () => {
  const seeded = seedSettingsFromEnv({ DRP_MOUNT_POINT: "/mnt/wd$(reboot)" } as NodeJS.ProcessEnv);
  assert.equal(seeded.mountPoint, defaultSettings().mountPoint);
  assert.ok(!seeded.mountPoint.includes("$"));
});

test("loadSettings: a hostile persisted mountPoint is reverted on load", () => {
  const dir = mkdtempSync(join(tmpdir(), "drp-settings-"));
  try {
    // Write a hostile settings.json directly (bypassing validation), then reload.
    const bad = { ...defaultSettings(), mountPoint: "/mnt/wd; reboot" };
    writeFileSync(join(dir, "settings.json"), JSON.stringify(bad), "utf8");
    const loaded = loadSettings(dir);
    assert.equal(loaded.mountPoint, defaultSettings().mountPoint);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tightened UUID regex (canonical 8-4-4-4-12).
// ---------------------------------------------------------------------------

test("validateSettings: 36 hex chars WITHOUT dash structure is now rejected", () => {
  const bad = withDefaults({ uuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }); // 36 hex, no dashes
  const { errors, resetFields, settings } = validateSettings(bad);
  assert.ok(errors.some((e) => e.includes("uuid")));
  assert.ok(resetFields.includes("uuid"));
  assert.equal(settings.uuid, defaultSettings().uuid);
});

test("validateSettings: a canonical UUID passes unchanged", () => {
  const good = withDefaults({ uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
  const { errors, resetFields, settings } = validateSettings(good);
  assert.deepEqual(errors, []);
  assert.deepEqual(resetFields, []);
  assert.equal(settings.uuid, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
});

// ---------------------------------------------------------------------------
// Folder caps (<=64 entries, <=255 chars each).
// ---------------------------------------------------------------------------

test("validateSettings: more than 64 folders is rejected and reverted", () => {
  const many = Array.from({ length: 65 }, (_, i) => `Folder${i}`);
  const { errors, resetFields, settings } = validateSettings(withDefaults({ folders: many }));
  assert.ok(errors.some((e) => e.includes("64")));
  assert.ok(resetFields.includes("folders"));
  assert.deepEqual(settings.folders, defaultSettings().folders);
});

test("validateSettings: a folder name over 255 chars is rejected and reverted", () => {
  const long = "x".repeat(256);
  const { errors, resetFields, settings } = validateSettings(withDefaults({ folders: [long] }));
  assert.ok(errors.length > 0);
  assert.ok(resetFields.includes("folders"));
  assert.deepEqual(settings.folders, defaultSettings().folders);
});

test("validateSettings: a folder name containing '/' is rejected and reverted", () => {
  const { resetFields, settings } = validateSettings(withDefaults({ folders: ["Movies", "a/b"] }));
  assert.ok(resetFields.includes("folders"));
  assert.deepEqual(settings.folders, defaultSettings().folders);
});

// ---------------------------------------------------------------------------
// PUT path still REJECTS (no silent revert while the user is editing).
// ---------------------------------------------------------------------------

test("SettingsStore.update: rejects a hostile mountPoint instead of reverting it", () => {
  const dir = mkdtempSync(join(tmpdir(), "drp-settings-"));
  try {
    const store = new SettingsStore(dir, defaultSettings());
    const res = store.update({ mountPoint: "/mnt/wd$(reboot)" });
    assert.equal(res.ok, false);
    if (!res.ok) assert.ok(res.errors.length > 0);
    // The live value is untouched (the bad update did not apply).
    assert.equal(store.get().mountPoint, defaultSettings().mountPoint);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SettingsStore.update: a valid patch applies", () => {
  const dir = mkdtempSync(join(tmpdir(), "drp-settings-"));
  try {
    const store = new SettingsStore(dir, defaultSettings());
    const res = store.update({ mountPoint: "/mnt/newdrive" });
    assert.equal(res.ok, true);
    assert.equal(store.get().mountPoint, "/mnt/newdrive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
