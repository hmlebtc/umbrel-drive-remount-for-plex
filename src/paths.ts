/**
 * Pure derivations of the host paths this app touches, from Settings
 * (spec sections 5, 6). Centralised so status.ts, restore.ts, the monitor and
 * the mock adapter all agree on exactly which files/paths are in play.
 *
 * All paths are POSIX host paths (the app runs on umbrelOS/Linux; the real
 * adapter maps them under /proc/1/root, the mock simulates them in memory).
 */

import { posix } from 'node:path';

import type { Settings } from './types.js';

/** The host's fstab — checked for a stale/legacy manual mount entry. */
export const FSTAB_PATH = '/etc/fstab';

/** /dev/disk/by-uuid/<uuid> — presence of this symlink means the drive is attached. */
export function byUuidPath(s: Settings): string {
  return `/dev/disk/by-uuid/${s.uuid}`;
}

/** Host-side media root: the bind SOURCE (mountPoint + mediaSubdir). */
export function hostMediaPath(s: Settings): string {
  const sub = s.mediaSubdir.trim();
  return sub === '' ? s.mountPoint : posix.join(s.mountPoint, sub);
}

/** Umbrel per-app data dir for Plex (holds the live docker-compose.yml). */
export function appDataDir(s: Settings): string {
  return posix.join(s.umbrelRoot, 'app-data', s.plexAppId);
}

/** The live Plex compose file umbreld actually runs (not the pristine store copy). */
export function composePath(s: Settings): string {
  return posix.join(appDataDir(s), 'docker-compose.yml');
}

/** A user-authored override umbreld silently IGNORES — flagged for cleanup. */
export function legacyOverridePath(s: Settings): string {
  return posix.join(appDataDir(s), 'docker-compose.override.yml');
}

/** umbrelOS's officially supported, update-persistent pre-start hook. */
export function hookPath(s: Settings): string {
  return posix.join(s.umbrelRoot, 'custom-hooks', 'pre-start');
}

/** Expected Docker container name for the Plex `server` service. */
export function containerName(s: Settings): string {
  return `${s.plexAppId}_server_1`;
}
