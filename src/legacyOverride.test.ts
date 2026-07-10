// Unit tests for legacyOverride.ts (v0.1.2 "remove legacy override" action).
// Exercises the pure remove logic directly against the in-memory mock adapter:
// backup-then-delete on a present file, activity logging, and idempotency.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventLog } from "./events.js";
import { createMockAdapter } from "./mockAdapter.js";
import { legacyOverridePath } from "./paths.js";
import { defaultSettings } from "./settings.js";
import { removeLegacyOverride } from "./legacyOverride.js";

test("removeLegacyOverride: present override -> backed up, deleted, logged; then idempotent no-op", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drp-legacy-"));
  try {
    const settings = defaultSettings();
    const adapter = createMockAdapter("healthy");
    const events = new EventLog();
    const overridePath = legacyOverridePath(settings);

    // The mock ships the override present by default (mirrors the real box).
    assert.equal(await adapter.exists(overridePath), true, "override should start present");

    // First removal: removed:true, a real backup path, a backup file on disk,
    // and an info event describing the action.
    const first = await removeLegacyOverride(adapter, settings, dir, events);
    assert.equal(first.removed, true);
    assert.equal(typeof first.backupPath, "string");
    assert.ok(first.backupPath && first.backupPath.length > 0);

    const backups = readdirSync(join(dir, "backups")).filter(
      (n) => n.startsWith("docker-compose.override.yml.") && n.endsWith(".bak"),
    );
    assert.equal(backups.length, 1, "exactly one override backup should exist");

    const log = events.list();
    assert.equal(log.length, 1, "one activity event should have been logged");
    assert.equal(log[0]!.level, "info");
    assert.ok(
      log[0]!.message.indexOf("removed legacy docker-compose.override.yml") === 0,
      `unexpected event message: ${log[0]!.message}`,
    );

    // The adapter no longer sees the file.
    assert.equal(await adapter.exists(overridePath), false, "override should now be gone");

    // Second removal: idempotent no-op — nothing removed, no backup, no new event.
    const second = await removeLegacyOverride(adapter, settings, dir, events);
    assert.equal(second.removed, false);
    assert.equal(second.backupPath, null);

    const backups2 = readdirSync(join(dir, "backups")).filter(
      (n) => n.startsWith("docker-compose.override.yml.") && n.endsWith(".bak"),
    );
    assert.equal(backups2.length, 1, "no-op remove must not write another backup");
    assert.equal(events.list().length, 1, "no-op remove must not log another event");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeLegacyOverride: absent override (dataDir undefined) -> removed:false, backupPath:null", async () => {
  const settings = defaultSettings();
  const adapter = createMockAdapter("healthy");
  // Delete it first so the action sees an absent file.
  await adapter.removeFile(legacyOverridePath(settings));

  const res = await removeLegacyOverride(adapter, settings, undefined);
  assert.equal(res.removed, false);
  assert.equal(res.backupPath, null);
});
