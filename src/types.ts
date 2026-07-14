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

/**
 * How the stable path /mnt/wdexternal is backed (spec sections 1, 3):
 *   - "classic":     direct `mount -t <fsType> /dev/disk/by-uuid/<uuid>` (v0.1.x
 *                    behaviour, kept byte-for-byte; blocks umbreld's automount).
 *   - "cooperative": `mount --bind <umbrelMountPath> /mnt/wdexternal` so the ONE
 *                    drive serves both umbrelOS Files and Plex.
 */
export type MountMode = 'classic' | 'cooperative';

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
  /** Backing mode for the stable path (default "classic"; upgrade-safe). */
  mountMode: MountMode;
  /** Seconds to wait for umbreld to mount the drive before classic fallback (60–900, default 180). */
  graceSec: number;
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
  /** Container State.StartedAt (ISO), for the bind-generation recreate rule (spec section 5). */
  startedAt: string | null;
  /**
   * Spec section 5: in-container liveness. `docker exec <plex> ls <mediaPath>`
   * succeeded (media is actually visible INSIDE the running container) — distinct
   * from config-level {@link bindOk}. `true` when not applicable / not probed
   * (plex absent or not running) so it never becomes the sole health discriminator
   * there; only a probed `false` marks the live view dead.
   */
  liveOk: boolean;
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

// ---------------------------------------------------------------------------
// Backing (spec sections 1-4, 8) — the stable-path indirection layer.
// ---------------------------------------------------------------------------

/** Which backing currently serves /mnt/wdexternal (spec section 1). */
export type BackingActive = 'umbrel-bind' | 'direct' | 'none';

/**
 * One decoded /proc/1/mountinfo record (spec section 2). Field order per the
 * kernel format: mountId parentId major:minor(dropped) root mountpoint options
 * <optional-fields> " - " fstype source superOptions.
 */
export interface MountInfoEntry {
  mountId: number;
  parentId: number;
  root: string;
  mountpoint: string;
  options: string[];
  fsType: string;
  source: string;
  superOptions: string[];
}

/**
 * Persisted at ${DRP_DATA_DIR}/backing.json (atomic writes). The bind record
 * that lets discovery distinguish a bind-of-umbrel from a direct mount (both
 * look identical in mountinfo), reconciled against the live mount table each
 * tick (spec section 2).
 */
export interface BackingRecord {
  mode: MountMode;
  active: BackingActive;
  /** The umbrelOS /External mount path our bind currently points at, or null. */
  boundTo: string | null;
  /** Monotonic counter bumped on every bind/mount we make (Plex-liveness rule). */
  bindGeneration: number;
  /** ISO time of the last bind/mount change (Plex recreate + handover cooldown anchor). */
  lastBindChangeAt: string | null;
  /** ISO time the current grace window started (boot/drive-arrival/handover), or null. */
  graceStartedAt: string | null;
}

/** Live view of umbreld's /External mount of our device (spec section 8). */
export interface UmbrelMountStatus {
  found: boolean;
  path: string | null;
  readable: boolean;
}

export interface ReapCounts {
  dirs: number;
  mounts: number;
}

/** status.backing (spec section 8). */
export interface BackingStatus {
  mode: MountMode;
  active: BackingActive;
  umbrelMount: UmbrelMountStatus;
  bindGeneration: number;
  lastBindChangeAt: string | null;
  /** Present only while a grace window is counting down. */
  graceRemainingSec?: number;
  reaped: ReapCounts;
}

/**
 * Pure classification of the mount table (output of classifyBacking, input to
 * backingDecide). Carries only what is derivable from mountinfo + the record;
 * the engine layers the live readability probe onto umbrelMount.found before
 * deciding (an unreadable umbrelOS mount is not a usable backing target).
 */
export interface BackingView {
  umbrelMount: {
    found: boolean;
    path: string | null;
    mountId: number | null;
    source: string | null;
  };
  stablePath: {
    mounted: boolean;
    source: string;
    root: string;
    /** A direct device mount of the fs root (classic backing). */
    direct: boolean;
    /** Our bind of an umbrelOS mount (per the persisted record). */
    bindOfUmbrel: boolean;
    /** The recorded bind points at a path that is no longer the live umbrelOS mount. */
    boundElsewhere: boolean;
    /** The current stable-path mount is stale/dead (device gone, renumbered, or bind source unmounted). */
    stale: boolean;
  };
  record: BackingRecord | null;
}

/** Actions produced by the backing ladder (spec section 3). */
export type BackingAction = 'none' | 'wait' | 'bind' | 'direct-mount' | 'release' | 'handover';

export interface BackingDecision {
  action: BackingAction;
  reason: string;
}

/** Standing UI warnings (spec section 8). */
export type WarningCode =
  | 'FORMAT_DIALOG_EXPECTED'
  | 'EJECTED_IN_UMBREL'
  | 'WAITING_FOR_UMBREL_MOUNT';

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
  /** Spec section 8: the stable-path backing detail. */
  backing: BackingStatus;
  /** Spec section 8: standing operator warnings. */
  warnings: WarningCode[];
}

// ---------------------------------------------------------------------------
// Restore job (spec section 7) — the /api/job payload.
// ---------------------------------------------------------------------------

export type RestoreTrigger =
  | 'auto'
  | 'manual'
  | 'restart-plex'
  | 'switch-cooperative'
  | 'switch-classic';

export type StepName =
  | 'preflight'
  | 'bootHook'
  | 'mount'
  | 'composePatch'
  | 'recreate'
  | 'verify'
  // Migration job steps (spec section 6).
  | 'set-mode'
  | 'reap'
  | 'unmount'
  | 'rescan'
  | 'wait-umbrel'
  | 'bind';

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
