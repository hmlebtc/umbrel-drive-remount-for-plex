// Tests for backups.ts (spec section 6 "Backups": snapshot before every host
// mutation, retention of the newest 20 per basename).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backupFile, backupsDir, BACKUP_RETENTION } from "./backups.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "drp-backups-"));
}

test("backupFile: writes a timestamped .bak with the previous content", () => {
  const dir = tmp();
  try {
    const path = backupFile(dir, "/home/umbrel/umbrel/custom-hooks/pre-start", "#!/bin/sh\nold\n");
    assert.ok(path, "expected a backup path");
    assert.ok(existsSync(path!), "backup file should exist");
    assert.equal(readFileSync(path!, "utf8"), "#!/bin/sh\nold\n");
    const base = path!.split(/[\\/]/).pop()!;
    assert.ok(base.startsWith("pre-start."), "filename should start with the source basename");
    assert.ok(base.endsWith(".bak"));
    // No colons/dots-as-time-separators in the filename (safe chars only).
    assert.ok(!base.slice(0, -4).includes(":"), "timestamp must not contain ':'");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backupFile: returns null (no file) when the target did not exist", () => {
  const dir = tmp();
  try {
    const path = backupFile(dir, "/home/umbrel/umbrel/app-data/plex/docker-compose.yml", null);
    assert.equal(path, null);
    assert.ok(!existsSync(backupsDir(dir)) || readdirSync(backupsDir(dir)).length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backupFile: retains only the newest 20 backups per basename", () => {
  const dir = tmp();
  try {
    const source = "/home/umbrel/umbrel/app-data/plex/docker-compose.yml";
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    const total = BACKUP_RETENTION + 5; // 25
    const paths: string[] = [];
    for (let i = 0; i < total; i++) {
      const p = backupFile(dir, source, `content-${i}`, new Date(base + i * 1000));
      assert.ok(p, `backup ${i} should be created`);
      paths.push(p!);
    }
    const remaining = readdirSync(backupsDir(dir)).filter(
      (n) => n.startsWith("docker-compose.yml.") && n.endsWith(".bak"),
    );
    assert.equal(remaining.length, BACKUP_RETENTION, "only the newest 20 should remain");

    // The 5 oldest were pruned; the 20 newest survive.
    const remainingSet = new Set(remaining);
    for (let i = 0; i < 5; i++) {
      const oldBase = paths[i]!.split(/[\\/]/).pop()!;
      assert.ok(!remainingSet.has(oldBase), `oldest backup ${i} should have been pruned`);
    }
    for (let i = 5; i < total; i++) {
      const keepBase = paths[i]!.split(/[\\/]/).pop()!;
      assert.ok(remainingSet.has(keepBase), `newest backup ${i} should be kept`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backupFile: retention is per-basename (hook and compose counted separately)", () => {
  const dir = tmp();
  try {
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    for (let i = 0; i < 22; i++) {
      backupFile(dir, "/x/pre-start", `h${i}`, new Date(base + i * 1000));
      backupFile(dir, "/y/docker-compose.yml", `c${i}`, new Date(base + i * 1000));
    }
    const names = readdirSync(backupsDir(dir));
    const hooks = names.filter((n) => n.startsWith("pre-start.")).length;
    const composes = names.filter((n) => n.startsWith("docker-compose.yml.")).length;
    assert.equal(hooks, BACKUP_RETENTION);
    assert.equal(composes, BACKUP_RETENTION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
