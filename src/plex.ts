/**
 * Plex container helpers shared by the restore job and the backing engine
 * (spec sections 5, 7).
 *
 * - recreatePlex(): the ONE proven recreate path — a direct `docker compose ...
 *   up -d --force-recreate` (no umbreld CLI exists on umbrelOS), with APP_ID /
 *   APP_DATA_DIR / UMBREL_ROOT / DEVICE_HOSTNAME passed as nsenter env.
 * - probeLiveOk(): the in-container liveness probe (`docker exec <plex> ls
 *   <mediaPath>`, 5s) — distinct from config-level bindOk: Docker resolves bind
 *   sources at container start, so a re-point after Plex started leaves the
 *   container on a dead view even though the compose/binds still LOOK correct.
 */

import type { HostAdapter } from './hostAdapter.js';
import { appDataDir, composePath } from './paths.js';
import type { Settings } from './types.js';

/** 5-second timeout for the in-container liveness probe (spec section 5). */
export const LIVEOK_TIMEOUT_MS = 5000;

export interface RecreateResult {
  ok: boolean;
  /** Log line to record on the calling step (kept identical across callers). */
  message: string;
}

export async function recreatePlex(adapter: HostAdapter, settings: Settings): Promise<RecreateResult> {
  const hostname = await adapter.hostname();
  const env: Record<string, string> = {
    APP_ID: settings.plexAppId,
    APP_DATA_DIR: appDataDir(settings),
    UMBREL_ROOT: settings.umbrelRoot,
    DEVICE_HOSTNAME: hostname,
  };

  const compose = await adapter.exec(
    [
      'docker',
      'compose',
      '-p',
      settings.plexAppId,
      '-f',
      composePath(settings),
      'up',
      '-d',
      '--force-recreate',
      '--no-deps',
      'server',
    ],
    { env },
  );
  if (compose.code === 0) {
    return { ok: true, message: 'recreated via docker compose' };
  }
  return { ok: false, message: `docker compose failed (code ${compose.code}): ${compose.stderr.trim()}` };
}

/**
 * In-container liveness: does `docker exec <container> ls <containerMediaPath>`
 * succeed? A dead bind view (source re-pointed after start) makes this fail even
 * while host-side media is fine. Returns false on any non-zero / timeout.
 */
export async function probeLiveOk(
  adapter: HostAdapter,
  settings: Settings,
  containerName: string,
): Promise<boolean> {
  const r = await adapter.exec(['docker', 'exec', containerName, 'ls', settings.containerMediaPath], {
    timeoutMs: LIVEOK_TIMEOUT_MS,
  });
  return r.code === 0;
}
