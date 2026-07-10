/**
 * "Remove legacy override" action (v0.1.2 feature).
 *
 * The status probe flags a stale, user-authored docker-compose.override.yml at
 * legacyOverridePath(settings) (composePatch.legacyOverridePresent). umbreld
 * IGNORES override files entirely — it starts apps with explicit --file flags —
 * so the override is inert; deleting it changes nothing functional and only
 * clears the status note. This one-shot action lets the user do that from the
 * dashboard instead of SSHing in.
 *
 * It is deliberately INDEPENDENT of the restore single-flight lock (it touches a
 * different file and mutates no live app state), so it is never gated on a
 * running restore job.
 */

import { backupFile } from './backups.js';
import type { EventLog } from './events.js';
import type { HostAdapter } from './hostAdapter.js';
import { legacyOverridePath } from './paths.js';
import type { Settings } from './types.js';

export interface RemoveLegacyOverrideResult {
  /** True iff an override file was actually present and has now been deleted. */
  removed: boolean;
  /** Path of the pre-delete backup under ${dataDir}/backups, or null. */
  backupPath: string | null;
}

/**
 * If a legacy override exists at legacyOverridePath(settings): snapshot its
 * current content to ${dataDir}/backups, delete it via the adapter, log an
 * activity event, and report {removed:true, backupPath}. If it does not exist:
 * report {removed:false, backupPath:null} (idempotent no-op).
 */
export async function removeLegacyOverride(
  adapter: HostAdapter,
  settings: Settings,
  dataDir: string | undefined,
  events?: EventLog,
): Promise<RemoveLegacyOverrideResult> {
  const overridePath = legacyOverridePath(settings);
  const content = await adapter.readFile(overridePath);
  if (content === null) {
    // Nothing to remove — the file does not exist.
    return { removed: false, backupPath: null };
  }
  const backupPath = dataDir !== undefined ? backupFile(dataDir, overridePath, content) : null;
  await adapter.removeFile(overridePath);
  events?.info(
    'legacy-override',
    `removed legacy docker-compose.override.yml${backupPath ? ` (backed up to ${backupPath})` : ''}`,
  );
  return { removed: true, backupPath };
}
