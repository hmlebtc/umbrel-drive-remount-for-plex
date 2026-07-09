/**
 * App version + git provenance (mirrors the OCEAN reference app's version.ts).
 *
 * Both prefer an explicit env var (injected as a Docker build ARG -> ENV so the
 * runtime image carries them) and fall back sensibly: APP_VERSION reads the
 * committed package.json, GIT_SHA becomes "dev" for local/uncontainerised runs.
 */

import { readFileSync } from 'node:fs';

function readPackageVersion(): string {
  try {
    // dist/version.js -> ../package.json (also true in the runtime image, which
    // copies package.json alongside dist/).
    const url = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export const APP_VERSION: string = process.env.APP_VERSION || readPackageVersion();

/** Short (7-char) git sha, or "dev" when built outside CI. */
export const GIT_SHA: string = (process.env.GIT_SHA || 'dev').slice(0, 7);

export const APP_NAME = 'Drive Remount for Plex' as const;
