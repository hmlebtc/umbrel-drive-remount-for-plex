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
import type { ExecOptions, ExecResult, HostAdapter, PlexInspect } from "./hostAdapter.js";
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
// Deterministic concurrency harness (fixes flaky #66).
//
// The healthy restore is an instant no-op (probeStatus -> isHealthy -> finish
// in microtasks), so firing two POST /api/restore via Promise.all is a pure
// event-loop race: the second request may observe the already-finished job
// (=> 200) instead of running:true (=> 409). Rather than relax the assertion,
// we make the first job deterministically IN-FLIGHT when the second request
// arrives, by gating the FIRST host-adapter method the restore job awaits.
//
// The restore job's execute() calls probeStatus() first; probeStatus()'s very
// first adapter await (with a non-empty uuid, which defaultSettings() has) is
// `adapter.exists(byUuidPath)`. GatedFirstExistsAdapter blocks that ONE first
// exists() call on a test-controlled gate — signalling `entered` when reached —
// then delegates normally forever after. Every other method delegates
// unchanged. A plain delegating class (no Proxy) avoids this-binding pitfalls.
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

class GatedFirstExistsAdapter implements HostAdapter {
  private tripped = false;

  constructor(
    private readonly base: HostAdapter,
    private readonly gate: Promise<void>,
    private readonly onEntered: () => void,
  ) {}

  async exists(hostPath: string): Promise<boolean> {
    if (!this.tripped) {
      this.tripped = true;
      // The restore job has now reached its first host read: it is genuinely
      // running (running:true). Signal the test, then park until released so a
      // second request provably races an in-flight — not a finished — job.
      this.onEntered();
      await this.gate;
    }
    return this.base.exists(hostPath);
  }

  readFile(hostPath: string): Promise<string | null> {
    return this.base.readFile(hostPath);
  }
  writeFileAtomic(hostPath: string, content: string, mode?: number): Promise<void> {
    return this.base.writeFileAtomic(hostPath, content, mode);
  }
  listDir(hostPath: string): Promise<string[] | null> {
    return this.base.listDir(hostPath);
  }
  realpath(hostPath: string): Promise<string | null> {
    return this.base.realpath(hostPath);
  }
  readProcMounts(): Promise<string> {
    return this.base.readProcMounts();
  }
  exec(argv: string[], opts?: ExecOptions): Promise<ExecResult> {
    return this.base.exec(argv, opts);
  }
  hostname(): Promise<string> {
    return this.base.hostname();
  }
  inspectPlex(plexAppId: string): Promise<PlexInspect> {
    return this.base.inspectPlex(plexAppId);
  }
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
  // Deterministic single-flight proof (no Promise.all, no reliance on job
  // duration): request A's restore job is held IN-FLIGHT on the gate while
  // request B races it, so B provably sees running:true and 409s.
  const dir = mkdtempSync(join(tmpdir(), "drp-server-"));
  const settings = new SettingsStore(dir, defaultSettings());
  const gate = deferred<void>();
  const entered = deferred<void>();
  const adapter = new GatedFirstExistsAdapter(
    createMockAdapter("healthy"),
    gate.promise,
    () => entered.resolve(),
  );
  const restore = createRestoreRunner(adapter, () => settings.get());
  const ctx: AppContext = {
    adapter,
    settings,
    restore,
    mock: true,
    startedAt: new Date().toISOString(),
    version: "0.1.0",
    gitSha: "test-sha",
  };
  try {
    await withServer(ctx, async (baseUrl) => {
      // Fire A without awaiting; its restore job parks on the gate.
      const p1 = postJSON(baseUrl, "/api/restore", { confirm: true });

      // Wait until A's job has actually entered execute() and is holding the
      // gate: it is now deterministically running:true.
      await entered.promise;

      // B must observe the in-flight job and be rejected with 409.
      const second = await postJSON(baseUrl, "/api/restore", { confirm: true });
      assert.equal(second.status, 409, "a second restore while one runs must 409");
      assert.equal(second.body.ok, false);
      assert.equal(typeof second.body.error, "string");

      // Release the gate and let A run to completion; it must have succeeded
      // with a jobId (the healthy no-op finishes after the gate is lifted).
      gate.resolve();
      const first = await p1;
      assert.equal(first.status, 200, "the first restore must be accepted");
      assert.equal(first.body.ok, true);
      assert.equal(typeof first.body.data.jobId, "string");
      assert.ok(first.body.data.jobId.length > 0);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
