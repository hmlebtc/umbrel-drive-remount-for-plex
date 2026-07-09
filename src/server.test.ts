// Tests for server.ts (spec section 9 HTTP API). server.ts, restore.ts,
// settings.ts, mockAdapter.ts do not exist at the time this file was written
// (B1 builds in parallel).
//
// ============================================================================
// ASSUMED CONTRACT (integration agent: reconcile names/shapes against B1's
// actual exports; mirrors OCEAN's server.ts `createApiServer(ctx)` pattern
// per spec section 3's "mirror OCEAN conventions exactly"):
//
//   // server.ts
//   export interface AppContext {
//     adapter: HostAdapter;
//     settings: SettingsStore;      // .get() / .update(patch)
//     restore: RestoreRunnerT;      // from restore.ts createRestoreRunner()
//     mock: boolean;                // true iff process.env.MOCK === "1"
//     startedAt: string;
//     version: string;
//     gitSha: string;
//   }
//   export function createApiServer(ctx: AppContext): http.Server;
//
//   // settings.ts
//   export function defaultSettings(): Settings;
//   export class SettingsStore {
//     constructor(dataDir: string, initial?: Settings);
//     get(): Settings;
//     update(patch: Partial<Settings>): { ok: true } | { ok: false; errors: string[] };
//   }
//
// All JSON responses use the section-9 envelope: {ok:true,data} | {ok:false,error}.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { createMockAdapter } from "./mockAdapter.js";
import { createRestoreRunner } from "./restore.js";
import { defaultSettings, SettingsStore } from "./settings.js";
import { createApiServer, type AppContext } from "./server.js";

interface Harness {
  ctx: AppContext;
  cleanup: () => void;
}

function buildCtx(opts: { mock?: boolean } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "drp-server-"));
  const settings = new SettingsStore(dir, defaultSettings());
  const adapter = createMockAdapter("healthy");
  const restore = createRestoreRunner(adapter, () => settings.get());
  const ctx: AppContext = {
    adapter,
    settings,
    restore,
    mock: opts.mock ?? true,
    startedAt: new Date().toISOString(),
    version: "0.1.0",
    gitSha: "test-sha",
  };
  return { ctx, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function withServer<T>(ctx: AppContext, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createApiServer(ctx);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function getJSON(baseUrl: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(baseUrl + path);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function postJSON(baseUrl: string, path: string, payload: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(baseUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function putJSON(baseUrl: string, path: string, payload: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(baseUrl + path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Boot on port 0 with a mock adapter; envelope shape on /api/status.
// ---------------------------------------------------------------------------

test("GET /api/status: boots on an ephemeral port and returns the section-9 envelope shape", async () => {
  const { ctx, cleanup } = buildCtx();
  try {
    await withServer(ctx, async (baseUrl) => {
      const { status, body } = await getJSON(baseUrl, "/api/status");
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      const data = body.data;
      assert.ok(data, "expected an envelope data payload");
      for (const key of [
        "timestamp",
        "version",
        "gitSha",
        "drive",
        "mount",
        "bootHook",
        "composePatch",
        "plex",
        "media",
        "autoHeal",
        "lastRestore",
      ]) {
        assert.ok(key in data, `expected /api/status data to include "${key}"`);
      }
    });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// POST /api/restore: confirm:true enforcement + jobId + 409 concurrent.
// ---------------------------------------------------------------------------

test("POST /api/restore: without confirm:true -> 4xx envelope error", async () => {
  const { ctx, cleanup } = buildCtx();
  try {
    await withServer(ctx, async (baseUrl) => {
      const { status, body } = await postJSON(baseUrl, "/api/restore", {});
      assert.ok(status >= 400 && status < 500, `expected 4xx, got ${status}`);
      assert.equal(body.ok, false);
      assert.equal(typeof body.error, "string");
    });
  } finally {
    cleanup();
  }
});

test("POST /api/restore: with confirm:true -> 200 with a jobId", async () => {
  const { ctx, cleanup } = buildCtx();
  try {
    await withServer(ctx, async (baseUrl) => {
      const { status, body } = await postJSON(baseUrl, "/api/restore", { confirm: true });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(typeof body.data.jobId, "string");
      assert.ok(body.data.jobId.length > 0);
    });
  } finally {
    cleanup();
  }
});

test("POST /api/restore: a second concurrent request -> 409", async () => {
  const { ctx, cleanup } = buildCtx();
  try {
    await withServer(ctx, async (baseUrl) => {
      const [first, second] = await Promise.all([
        postJSON(baseUrl, "/api/restore", { confirm: true }),
        postJSON(baseUrl, "/api/restore", { confirm: true }),
      ]);
      const statuses = [first.status, second.status].sort();
      assert.deepEqual(statuses, [200, 409]);
      const conflict = first.status === 409 ? first : second;
      assert.equal(conflict.body.ok, false);
    });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// /api/mock/scenario: 404 when MOCK unset, works when MOCK=1.
// ---------------------------------------------------------------------------

test("POST /api/mock/scenario: 404 when the server was booted without MOCK=1", async () => {
  const { ctx, cleanup } = buildCtx({ mock: false });
  try {
    await withServer(ctx, async (baseUrl) => {
      const res = await fetch(baseUrl + "/api/mock/scenario", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario: "driveAbsent", confirm: true }),
      });
      assert.equal(res.status, 404);
    });
  } finally {
    cleanup();
  }
});

test("POST /api/mock/scenario: works (200 ok:true) when the server was booted with MOCK=1", async () => {
  const { ctx, cleanup } = buildCtx({ mock: true });
  try {
    await withServer(ctx, async (baseUrl) => {
      const { status, body } = await postJSON(baseUrl, "/api/mock/scenario", {
        scenario: "driveAbsent",
        confirm: true,
      });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
    });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// PUT /api/settings: rejects bad uuid / relative paths.
// ---------------------------------------------------------------------------

test("PUT /api/settings: rejects a malformed uuid", async () => {
  const { ctx, cleanup } = buildCtx();
  try {
    await withServer(ctx, async (baseUrl) => {
      const { status, body } = await putJSON(baseUrl, "/api/settings", { uuid: "not-a-uuid" });
      assert.ok(status >= 400 && status < 500, `expected 4xx, got ${status}`);
      assert.equal(body.ok, false);
      assert.equal(typeof body.error, "string");
    });
  } finally {
    cleanup();
  }
});

test("PUT /api/settings: rejects a relative mountPoint path", async () => {
  const { ctx, cleanup } = buildCtx();
  try {
    await withServer(ctx, async (baseUrl) => {
      const { status, body } = await putJSON(baseUrl, "/api/settings", { mountPoint: "relative/path" });
      assert.ok(status >= 400 && status < 500, `expected 4xx, got ${status}`);
      assert.equal(body.ok, false);
      assert.equal(typeof body.error, "string");
    });
  } finally {
    cleanup();
  }
});

test("PUT /api/settings: a valid patch is accepted and applied", async () => {
  const { ctx, cleanup } = buildCtx();
  try {
    await withServer(ctx, async (baseUrl) => {
      const { status, body } = await putJSON(baseUrl, "/api/settings", { mountPoint: "/mnt/newdrive" });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(ctx.settings.get().mountPoint, "/mnt/newdrive");
    });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Fix #7: /api/status lastRestore carries `at` (finishedAt ?? startedAt).
// ---------------------------------------------------------------------------

test("GET /api/status: lastRestore.at is populated after a restore is started", async () => {
  const { ctx, cleanup } = buildCtx();
  try {
    await withServer(ctx, async (baseUrl) => {
      const started = await postJSON(baseUrl, "/api/restore", { confirm: true });
      assert.equal(started.status, 200);

      const { body } = await getJSON(baseUrl, "/api/status");
      const lr = body.data.lastRestore;
      assert.ok(lr, "expected a lastRestore summary once a job exists");
      assert.equal(typeof lr.at, "string", "lastRestore.at must be a timestamp string");
      assert.ok(lr.at.length > 0);
      assert.ok("trigger" in lr && "result" in lr, "lastRestore must carry trigger + result");
    });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// /healthz
// ---------------------------------------------------------------------------

test("GET /healthz: 200", async () => {
  const { ctx, cleanup } = buildCtx();
  try {
    await withServer(ctx, async (baseUrl) => {
      const res = await fetch(baseUrl + "/healthz");
      assert.equal(res.status, 200);
    });
  } finally {
    cleanup();
  }
});
