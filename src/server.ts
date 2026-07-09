/**
 * HTTP API (spec section 9). node:http only — no framework, no auth (Umbrel's
 * app_proxy is the boundary in front of this dashboard). Every JSON response
 * uses the envelope {ok:true,data} | {ok:false,error}. Mutating actions that
 * are destructive (restore / restart) require {confirm:true}; a second restore
 * while one runs returns 409 (single-flight). Bodies are capped at 64 KB and
 * the router never throws out (a bad request can't take the process down).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { DASHBOARD_HTML, FAVICON_SVG } from './dashboard.js';
import type { EventLog } from './events.js';
import type { HostAdapter } from './hostAdapter.js';
import type { Monitor } from './monitor.js';
import type { RestoreRunner } from './restore.js';
import type { SettingsStore } from './settings.js';
import { probeStatus } from './status.js';
import type { AppStatus, RestoreJob, RestoreSummary, Settings } from './types.js';

const BODY_LIMIT = 64 * 1024;

export interface AppContext {
  adapter: HostAdapter;
  settings: SettingsStore;
  restore: RestoreRunner;
  mock: boolean;
  startedAt: string;
  version: string;
  gitSha: string;
  monitor?: Monitor;
  events?: EventLog;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Response helpers (section-9 envelope)
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function ok(res: ServerResponse, data: unknown): void {
  sendJson(res, 200, { ok: true, data });
}

function fail(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { ok: false, error: message });
}

function sendText(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

interface BodyRead {
  ok: boolean;
  tooLarge: boolean;
  text: string;
}

function readBody(req: IncomingMessage): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const done = (r: BodyRead): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        done({ ok: false, tooLarge: true, text: '' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => done({ ok: true, tooLarge: false, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => done({ ok: false, tooLarge: false, text: '' }));
  });
}

function parseJson(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    const v = JSON.parse(text);
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return { ok: true, value: v as Record<string, unknown> };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Status assembly
// ---------------------------------------------------------------------------

function summarizeJob(job: RestoreJob | null): RestoreSummary | null {
  if (!job) return null;
  return {
    jobId: job.jobId ?? '',
    trigger: job.trigger ?? '',
    startedAt: job.startedAt ?? '',
    finishedAt: job.finishedAt,
    at: job.finishedAt ?? job.startedAt ?? null,
    ok: job.result !== null && !job.steps.some((s) => s.state === 'failed'),
    result: job.result,
  };
}

async function buildStatus(ctx: AppContext): Promise<AppStatus> {
  const settings = ctx.settings.get();
  const status = await probeStatus(ctx.adapter, settings);
  status.version = ctx.version;
  status.gitSha = ctx.gitSha;
  status.autoHeal = ctx.monitor
    ? ctx.monitor.snapshot()
    : {
        enabled: settings.autoHeal.enabled,
        lastCheckAt: null,
        lastActionAt: null,
        consecutiveFailures: 0,
        suspended: false,
      };
  status.lastRestore = summarizeJob(ctx.restore.getJob());
  return status;
}

// ---------------------------------------------------------------------------
// Mutating handlers
// ---------------------------------------------------------------------------

async function handleSettingsPut(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  if (body.tooLarge) return fail(res, 413, 'request body too large');
  if (!body.ok) return fail(res, 400, 'could not read request body');
  const parsed = parseJson(body.text);
  if (!parsed.ok) return fail(res, 400, 'invalid JSON body');

  const result = ctx.settings.update(parsed.value as Partial<Settings>);
  if (!result.ok) return fail(res, 400, result.errors.join('; '));
  ctx.monitor?.reschedule();
  ctx.events?.info('settings', 'settings updated via API');
  return ok(res, ctx.settings.get());
}

async function handleRestore(
  ctx: AppContext,
  req: IncomingMessage,
  res: ServerResponse,
  trigger: 'manual' | 'restart-plex',
): Promise<void> {
  const body = await readBody(req);
  if (body.tooLarge) return fail(res, 413, 'request body too large');
  if (!body.ok) return fail(res, 400, 'could not read request body');
  const parsed = parseJson(body.text);
  if (!parsed.ok) return fail(res, 400, 'invalid JSON body');
  if (parsed.value.confirm !== true) {
    return fail(res, 400, 'confirmation required: send {"confirm": true}');
  }
  const started = ctx.restore.start(trigger);
  if (!started.ok) return fail(res, 409, started.error);
  return ok(res, { jobId: started.jobId });
}

async function handleAutoHeal(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  if (body.tooLarge) return fail(res, 413, 'request body too large');
  if (!body.ok) return fail(res, 400, 'could not read request body');
  const parsed = parseJson(body.text);
  if (!parsed.ok) return fail(res, 400, 'invalid JSON body');
  const enabled = Boolean(parsed.value.enabled);
  const current = ctx.settings.get();
  const result = ctx.settings.update({ autoHeal: { ...current.autoHeal, enabled } });
  if (!result.ok) return fail(res, 400, result.errors.join('; '));
  ctx.monitor?.reschedule();
  ctx.events?.info('autoheal', `auto-heal ${enabled ? 'enabled' : 'disabled'} via API`);
  return ok(res, ctx.settings.get());
}

async function handleMockScenario(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  if (body.tooLarge) return fail(res, 413, 'request body too large');
  const parsed = parseJson(body.text);
  if (!parsed.ok) return fail(res, 400, 'invalid JSON body');
  const scenario = typeof parsed.value.scenario === 'string' ? parsed.value.scenario : '';
  const maybe = ctx.adapter as { setScenario?: (s: string) => void };
  if (typeof maybe.setScenario !== 'function') {
    return fail(res, 500, 'mock adapter not available');
  }
  try {
    maybe.setScenario(scenario);
  } catch (e) {
    return fail(res, 400, errMsg(e));
  }
  ctx.events?.info('mock', `scenario set to ${scenario}`);
  return ok(res, { scenario });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  // Static / health
  if (method === 'GET' && path === '/') return sendText(res, 200, DASHBOARD_HTML, 'text/html; charset=utf-8');
  if (method === 'GET' && path === '/favicon.svg') return sendText(res, 200, FAVICON_SVG, 'image/svg+xml');
  if (method === 'GET' && path === '/healthz') return sendText(res, 200, 'ok', 'text/plain; charset=utf-8');

  // Read-only JSON
  if (method === 'GET' && path === '/api/status') return ok(res, await buildStatus(ctx));
  if (method === 'GET' && path === '/api/job') return ok(res, ctx.restore.getJob());
  if (method === 'GET' && path === '/api/events') {
    const events = ctx.events ? ctx.events.list() : [];
    const n = Number(url.searchParams.get('limit'));
    const limited = Number.isFinite(n) && n > 0 ? events.slice(0, Math.floor(n)) : events;
    return ok(res, limited);
  }
  if (method === 'GET' && path === '/api/settings') return ok(res, ctx.settings.get());

  // Mutations
  if (method === 'PUT' && path === '/api/settings') return handleSettingsPut(ctx, req, res);
  if (method === 'POST' && path === '/api/check') return ok(res, await buildStatus(ctx));
  if (method === 'POST' && path === '/api/restore') return handleRestore(ctx, req, res, 'manual');
  if (method === 'POST' && path === '/api/restart-plex') return handleRestore(ctx, req, res, 'restart-plex');
  if (method === 'POST' && path === '/api/auto-heal') return handleAutoHeal(ctx, req, res);
  if (method === 'POST' && path === '/api/reset-failures') {
    ctx.monitor?.resetFailures();
    return ok(res, { reset: true });
  }

  // Mock-only (spec section 9): 404 unless the server was booted with MOCK=1.
  if (path === '/api/mock/scenario') {
    if (method !== 'POST') return fail(res, 404, 'not found');
    if (!ctx.mock) return fail(res, 404, 'not found');
    return handleMockScenario(ctx, req, res);
  }

  return fail(res, 404, 'not found');
}

export function createApiServer(ctx: AppContext): Server {
  return createServer((req, res) => {
    route(ctx, req, res).catch((err: unknown) => {
      if (!res.headersSent) fail(res, 500, errMsg(err));
      else res.end();
    });
  });
}
