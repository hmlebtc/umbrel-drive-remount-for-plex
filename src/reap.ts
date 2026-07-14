/**
 * Reaping planner (spec section 4) — PURE.
 *
 * umbreld's getUniqueName() appends " (2)", " (3)"… to the mount directory when
 * the target name already EXISTS, so a stale leftover directory (the Mar-5 empty
 * `wdexternal`) makes a fresh automount drift to `wdexternal (2)`. To let umbreld
 * reuse the clean name we, under <externalBase>/ ONLY and only for names that are
 * our sanitized label or `<label> (N)`:
 *   - rmdir EMPTY, UNMOUNTED directories, and
 *   - `umount -l` DEAD mounts (source device gone / EIO) then rmdir if empty.
 *
 * We NEVER touch non-empty directories, foreign labels, or LIVE mounts (a live
 * mount that is not ours is umbreld's current mount — untouchable). reapPlan is
 * side-effect free; the engine executes the plan through the adapter, bounded.
 */

import { sanitizeLabel } from './paths.js';

export interface ReapEntry {
  /** Bare directory name under externalBase (e.g. "wdexternal" or "wdexternal (2)"). */
  name: string;
  /** The directory has no entries. */
  empty: boolean;
  /** Something is mounted on the directory. */
  mounted: boolean;
  /** The mount on it is dead (source device gone / target unreadable / EIO). */
  dead: boolean;
}

export interface ReapPlan {
  /** Directory names to rmdir (executor prefixes externalBase; rmdir fails on non-empty). */
  rmdirs: string[];
  /** Directory names to `umount -l` before attempting the rmdir. */
  lazyUmounts: string[];
}

/**
 * True when `name` is exactly our sanitized label, or `<label> (N)` for an
 * integer N — the only names umbreld would have created for our drive.
 */
export function matchesLabel(name: string, label: string): boolean {
  const sanitized = sanitizeLabel(label);
  if (sanitized === '') return false;
  if (name === sanitized) return true;
  const driftRe = new RegExp(`^${escapeRegExp(sanitized)} \\(\\d+\\)$`);
  return driftRe.test(name);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Plan the reap actions for a directory listing under externalBase.
 *
 *   live mount (mounted && !dead)  -> SKIP (untouchable — umbreld's own mount)
 *   dead mount  (mounted && dead)  -> `umount -l`, then rmdir if it became empty
 *   empty, unmounted               -> rmdir
 *   non-empty, unmounted           -> SKIP (never delete data)
 *   non-matching name              -> SKIP (foreign label)
 */
export function reapPlan(listing: ReapEntry[], label: string): ReapPlan {
  const rmdirs: string[] = [];
  const lazyUmounts: string[] = [];

  for (const entry of listing) {
    if (!matchesLabel(entry.name, label)) continue;

    if (entry.mounted) {
      if (!entry.dead) continue; // live mount — never touch
      // Dead mount: lazy-umount, then try to rmdir the now-idle directory.
      lazyUmounts.push(entry.name);
      rmdirs.push(entry.name);
      continue;
    }

    // Unmounted directory: rmdir only when empty.
    if (entry.empty) rmdirs.push(entry.name);
  }

  return { rmdirs, lazyUmounts };
}
