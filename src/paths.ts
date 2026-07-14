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

/**
 * umbreld's external-storage base (spec section 0): `<umbrelRoot>/external`.
 * umbreld mounts each partition at `<externalBase>/<sanitizedLabel>`; this is
 * the ONLY directory the cooperative backing binds from and the ONLY directory
 * reaping is ever allowed to touch.
 */
export function externalBase(s: Settings): string {
  return posix.join(s.umbrelRoot, 'external');
}

/**
 * umbreld's filesystem-label sanitizer (spec section 0): strips every character
 * outside `[a-zA-Z0-9 '_-]`. Used to know which `<externalBase>/<name>` and
 * `<name> (N)` directories are ours to reap / bind.
 */
export function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9 '_-]/g, '');
}

/** Expected Docker container name for the Plex `server` service. */
export function containerName(s: Settings): string {
  return `${s.plexAppId}_server_1`;
}
