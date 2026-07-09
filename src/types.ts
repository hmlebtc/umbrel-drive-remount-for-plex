/**
 * Shared data types (spec sections 5, 7, 8, 9).
 *
 * This module is deliberately dependency-free: it only declares the JSON
 * shapes that cross module / HTTP boundaries. The pure decision function
 * `decide()` (monitor.ts) and the test-suite import their input/output types
 * from here, so the shapes below are the contract every other module honours.
 */

// ---------------------------------------------------------------------------
// Settings (spec section 5) — persisted at ${DRP_DATA_DIR}/settings.json.
// ---------------------------------------------------------------------------

export interface AutoHealSettings {
  /** Master switch for the background monitor's auto-heal behaviour. */
  enabled: boolean;
  /** Seconds between monitor ticks. */
  intervalSec: number;
  /** Seconds to wait after a restore attempt before another auto-heal fires. */
  cooldownSec: number;
  /** Consecutive failed auto-heals after which the monitor suspends itself. */
  maxConsecutiveFailures: number;
  /** Consecutive broken observations required before auto-heal fires (debounce). */
  requireConsecutiveBroken: number;
}

export interface Settings {
  /** Filesystem UUID of the external drive (from /dev/disk/by-uuid). */
  uuid: string;
  /** Filesystem type passed to `mount -t` (e.g. ext4, exfat, ntfs). */
  fsType: string;
  /** Absolute host path the drive is mounted at. */
  mountPoint: string;
  /** Subdirectory under mountPoint that holds the media (bind source root). */
  mediaSubdir: string;
  /** Media library folders under the media path whose presence is checked. */
  folders: string[];
  /** Umbrel app id of the Plex app (container is `${plexAppId}_server_1`). */
  plexAppId: string;
  /** Umbrel install root (holds app-data/ and custom-hooks/). */
  umbrelRoot: string;
  /** Path the media appears at INSIDE the Plex container (bind destination). */
  containerMediaPath: string;
  autoHeal: AutoHealSettings;
}

// ---------------------------------------------------------------------------
// Status (spec sections 6, 9) — the /api/status payload; decide()'s input.
// ---------------------------------------------------------------------------

export interface DriveStatus {
  present: boolean;
  device: string | null;
}

export interface MountStatus {
  mounted: boolean;
  stale: boolean;
  source: string;
  target: string;
  fsType: string;
  rw: boolean;
}

export interface BootHookStatus {
  ok: boolean;
  path: string;
  problems: string[];
}

export interface ComposePatchStatus {
  ok: boolean;
  path: string;
  problems: string[];
  legacyOverridePresent: boolean;
  legacyFstabEntryPresent: boolean;
}

export interface ContainerBind {
  source: string;
  destination: string;
}

export interface PlexStatus {
  found: boolean;
  containerName: string | null;
  state: string | null;
  bindOk: boolean;
  binds: ContainerBind[];
}

export interface MediaFolderStatus {
  name: string;
  present: boolean;
  entries: number;
}

export interface MediaStatus {
  ok: boolean;
  folders: MediaFolderStatus[];
}

export interface AutoHealStatus {
  enabled: boolean;
  lastCheckAt: string | null;
  lastActionAt: string | null;
  consecutiveFailures: number;
  suspended: boolean;
}

export interface RestoreSummary {
  jobId: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  /** Spec section 9 lastRestore.at: finishedAt ?? startedAt (the "when"). */
  at: string | null;
  ok: boolean;
  result: string | null;
}

export interface AppStatus {
  timestamp: string;
  version: string;
  gitSha: string;
  drive: DriveStatus;
  mount: MountStatus;
  bootHook: BootHookStatus;
  composePatch: ComposePatchStatus;
  plex: PlexStatus;
  media: MediaStatus;
  autoHeal: AutoHealStatus;
  lastRestore: RestoreSummary | null;
}

// ---------------------------------------------------------------------------
// Restore job (spec section 7) — the /api/job payload.
// ---------------------------------------------------------------------------

export type RestoreTrigger = 'auto' | 'manual' | 'restart-plex';

export type StepName =
  | 'preflight'
  | 'bootHook'
  | 'mount'
  | 'composePatch'
  | 'recreate'
  | 'verify';

export type StepState = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

export interface LogEntry {
  ts: string;
  line: string;
}

export interface JobStep {
  name: StepName;
  state: StepState;
  log: LogEntry[];
}

export interface RestoreJob {
  running: boolean;
  jobId: string | null;
  trigger: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  steps: JobStep[];
  result: string | null;
}

// ---------------------------------------------------------------------------
// Monitor (spec section 8) — decide()'s carried state.
// ---------------------------------------------------------------------------

export interface MonitorHistory {
  /** True while a restore job is in flight (guards decide()). */
  jobRunning: boolean;
  /** True once maxConsecutiveFailures auto-heals have failed in a row. */
  suspended: boolean;
  /** Consecutive broken observations (debounce counter). */
  consecutiveBroken: number;
  /** Consecutive failed restore attempts (drives suspension). */
  consecutiveFailures: number;
  /** ISO timestamp of the last auto-heal restore attempt (cooldown anchor). */
  lastRestoreAt: string | null;
  /** Previous tick's drive.present, for the reconnect transition. */
  drivePresentPrev: boolean | null;
}

export type DecisionAction = 'none' | 'restore' | 'alert';

export interface Decision {
  action: DecisionAction;
  reason: string;
}

// ---------------------------------------------------------------------------
// Activity log (spec section 9) — the /api/events payload.
// ---------------------------------------------------------------------------

export type EventLevel = 'info' | 'warn' | 'error';

export interface ActivityEvent {
  at: string;
  level: EventLevel;
  kind: string;
  message: string;
}
