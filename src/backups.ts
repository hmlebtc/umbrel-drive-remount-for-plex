/**
 * Host-file backups (spec sections 6 "Backups" + 11).
 *
 * Before every mutating write of a managed host artifact (the boot hook or the
 * Plex compose file), restore.ts snapshots the CURRENT content here, into
 * `${dataDir}/backups/`. Backups live on the app's own /data volume (which
 * survives umbrelOS updates), NOT under the host rootfs — so they are written
 * with node:fs directly, never through the HostAdapter.
 *
 * Filename: `<basename>.<ISO-ts-with-safe-chars>.bak` — the timestamp has its
 * `:` and `.` replaced by `-` so it is filesystem-safe and still sorts
 * chronologically. Retention: newest 20 per basename. Nothing here throws on IO
 * problems (a failed backup must never abort a restore); it returns null.
 */

import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename as pathBasename, join } from 'node:path';

export const BACKUP_RETENTION = 20;

/** Directory backups for `dataDir` live in. */
export function backupsDir(dataDir: string): string {
  return join(dataDir, 'backups');
}

/** ISO timestamp with `:`/`.` swapped for `-` so it is a safe path component. */
function safeTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Snapshot `currentContent` (the file's content BEFORE we overwrite it) to
 * `${dataDir}/backups/<basename>.<ts>.bak`, then prune to the newest
 * BACKUP_RETENTION backups for that basename.
 *
 * Returns the backup file path, or null when there was nothing to back up
 * (the target file did not exist — `currentContent` is null) or an IO error
 * occurred. `now` is injectable for deterministic tests.
 */
export function backupFile(
  dataDir: string,
  sourcePath: string,
  currentContent: string | null,
  now: Date = new Date(),
): string | null {
  if (currentContent === null) return null; // target did not exist -> nothing to back up
  try {
    const dir = backupsDir(dataDir);
    mkdirSync(dir, { recursive: true });
    const base = pathBasename(sourcePath);
    const backupPath = join(dir, `${base}.${safeTimestamp(now)}.bak`);
    writeFileSync(backupPath, currentContent, 'utf8');
    pruneBackups(dir, base);
    return backupPath;
  } catch {
    return null;
  }
}

/** Keep only the newest BACKUP_RETENTION `.bak` files for `base` in `dir`. */
function pruneBackups(dir: string, base: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const mine = names
    .filter((n) => n.startsWith(`${base}.`) && n.endsWith('.bak'))
    .sort(); // safe-ISO timestamps sort lexically == chronologically (oldest first)
  const excess = mine.length - BACKUP_RETENTION;
  for (let i = 0; i < excess; i++) {
    try {
      unlinkSync(join(dir, mine[i]!));
    } catch {
      /* best-effort prune */
    }
  }
}
