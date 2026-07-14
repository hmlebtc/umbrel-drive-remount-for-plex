/**
 * The stable-path backing engine's PURE core (spec sections 2, 3).
 *
 * Three side-effect-free functions the whole coexistence feature is built on:
 *   - parseMountInfo():  decode /proc/1/mountinfo (octal escapes, the variable
 *                        optional-fields count, the " - " separator),
 *   - classifyBacking(): reconcile the mount table + our persisted bind record
 *                        into a BackingView (what is umbreld's mount, what backs
 *                        /mnt/wdexternal, is it stale/dead),
 *   - backingDecide():   the full A-E ladder — pick the next backing action.
 *
 * Everything here is unit-testable with plain data; the engine (backingEngine.ts)
 * layers the live readability probe and the actual host mutations on top.
 */

import type {
  BackingDecision,
  BackingView,
  MountInfoEntry,
  MountMode,
  BackingRecord,
} from './types.js';

/**
 * One automatic handover attempt (direct fallback -> umbrelOS bind) per this
 * window, so a flapping umbrelOS mount can never thrash Plex (spec section 3D).
 */
export const HANDOVER_COOLDOWN_SEC = 120;

// ---------------------------------------------------------------------------
// parseMountInfo
// ---------------------------------------------------------------------------

/** Decode /proc-style octal escapes (\040 -> space, \011 -> tab, \134 -> backslash, \012 -> NL). */
function decodeOctal(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/**
 * Parse the raw text of /proc/<pid>/mountinfo. Each line:
 *
 *   mountId parentId major:minor root mountpoint options [optional...] - fstype source superOptions
 *
 * The number of optional fields (`shared:1`, `master:2`, ...) VARIES and is
 * terminated by a single `-` field; we locate that separator rather than
 * assuming a fixed offset. Malformed/short lines are skipped.
 */
export function parseMountInfo(text: string): MountInfoEntry[] {
  const out: MountInfoEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') continue;
    const tokens = line.split(' ');
    // Minimum: 6 fixed fields + `-` separator + 3 post-separator fields = 10.
    if (tokens.length < 10) continue;

    // The separator is the first bare `-` at or after the optional-fields region
    // (index 6). Optional fields are `<tag>[:<value>]` and never a lone `-`.
    let sep = -1;
    for (let i = 6; i < tokens.length; i++) {
      if (tokens[i] === '-') {
        sep = i;
        break;
      }
    }
    if (sep === -1 || sep + 3 > tokens.length) continue;

    const mountId = Number(tokens[0]);
    const parentId = Number(tokens[1]);
    if (!Number.isFinite(mountId) || !Number.isFinite(parentId)) continue;

    out.push({
      mountId,
      parentId,
      majorMinor: tokens[2]!,
      root: decodeOctal(tokens[3]!),
      mountpoint: decodeOctal(tokens[4]!),
      options: tokens[5]!.split(','),
      fsType: tokens[sep + 1]!,
      source: decodeOctal(tokens[sep + 2]!),
      superOptions: (tokens[sep + 3] ?? '').split(','),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// classifyBacking
// ---------------------------------------------------------------------------

export interface ClassifyOptions {
  /** The device our UUID currently resolves to (e.g. /dev/sdb1), or null if the drive is absent. */
  device: string | null;
  /** The stable indirection path we own (/mnt/wdexternal). */
  mountPoint: string;
  /** umbreld's external-storage base (<umbrelRoot>/external). */
  externalBase: string;
  /** Our persisted bind record, or null before the first bind. */
  record: BackingRecord | null;
  /**
   * The by-uuid device's `major:minor` (spec section 2 "match source OR
   * major:minor", F7). When set, a mountinfo entry whose SOURCE string is
   * canonicalized differently but whose maj:min equals this still counts as our
   * device — preventing a missed umbrelMount / a double-mount.
   */
  deviceMajMin?: string | null;
}

/**
 * Reconcile the live mount table with our bind record into a BackingView.
 *
 * - umbrelMount: the NEWEST (largest mountId) fs-root mount of OUR device that
 *   sits under <externalBase>/ — umbreld's /External mount of the drive.
 * - stablePath: the top-of-stack mount at mountPoint, classified as direct vs.
 *   bind-of-umbrel via the record (both look identical in mountinfo), with a
 *   staleness verdict (device gone, source renumbered, or bind source unmounted).
 */
export function classifyBacking(entries: MountInfoEntry[], opts: ClassifyOptions): BackingView {
  const { device, mountPoint, externalBase } = opts;
  const record = opts.record;
  const deviceMajMin = opts.deviceMajMin ?? null;
  const basePrefix = externalBase.endsWith('/') ? externalBase : `${externalBase}/`;

  // Spec section 2 / F7: an entry is "our device" when its source string equals
  // the by-uuid device OR its maj:min matches (a differently-canonicalized source
  // rendering must not hide our mount).
  const isOurDevice = (e: MountInfoEntry): boolean =>
    device !== null &&
    (e.source === device || (deviceMajMin !== null && e.majorMinor === deviceMajMin));

  // --- umbrelMount ---------------------------------------------------------
  let umbrel: { path: string; mountId: number; source: string } | null = null;
  if (device !== null) {
    for (const e of entries) {
      if (e.root !== '/') continue;
      if (!isOurDevice(e)) continue;
      // A child directory under the external base (external/wdexternal), not the
      // base directory itself.
      if (e.mountpoint === externalBase) continue;
      if (!e.mountpoint.startsWith(basePrefix)) continue;
      if (umbrel === null || e.mountId > umbrel.mountId) {
        umbrel = { path: e.mountpoint, mountId: e.mountId, source: e.source };
      }
    }
  }
  const umbrelMount = umbrel
    ? { found: true, path: umbrel.path, mountId: umbrel.mountId, source: umbrel.source }
    : { found: false, path: null as string | null, mountId: null as number | null, source: null as string | null };

  // --- stable path mount (top of stack) ------------------------------------
  let spEntry: MountInfoEntry | null = null;
  for (const e of entries) {
    if (e.mountpoint !== mountPoint) continue;
    if (spEntry === null || e.mountId > spEntry.mountId) spEntry = e;
  }
  const mounted = spEntry !== null;
  const source = spEntry?.source ?? '';
  const root = spEntry?.root ?? '';
  const spIsOurDevice = spEntry !== null && isOurDevice(spEntry);

  const deviceGone = device === null;
  const sourceMismatch = mounted && device !== null && !spIsOurDevice;

  let direct = false;
  let bindOfUmbrel = false;
  let boundElsewhere = false;
  let stale = false;

  if (record?.active === 'umbrel-bind') {
    bindOfUmbrel = true;
    const targetLive = umbrelMount.found && umbrelMount.path === record.boundTo;
    boundElsewhere = umbrelMount.found && umbrelMount.path !== record.boundTo;
    // Stale when the mount is gone, the device vanished/renumbered, or the exact
    // umbrelOS mount we bound to is no longer present (empty/dead bind view).
    stale = !mounted || deviceGone || sourceMismatch || !targetLive;
  } else if (record?.active === 'direct') {
    direct = true;
    stale = !mounted || deviceGone || sourceMismatch;
  } else if (mounted) {
    // No record (or "none"): infer. A fs-root mount of the live device at the
    // stable path is a classic direct mount; anything else is an unrecognised /
    // dead mount we should treat as stale.
    if (!deviceGone && spIsOurDevice && root === '/') {
      direct = true;
    } else {
      stale = true;
    }
  }

  return {
    umbrelMount,
    stablePath: { mounted, source, root, direct, bindOfUmbrel, boundElsewhere, stale },
    record,
  };
}

// ---------------------------------------------------------------------------
// backingDecide — the A-E ladder (spec section 3)
// ---------------------------------------------------------------------------

export interface BackingDecideCtx {
  mode: MountMode;
  drivePresent: boolean;
  /** Seconds left in the grace window; 0 when grace is not/no-longer counting. */
  graceRemainingSec: number;
  plexRunning: boolean;
  /** Seconds since our last bind/mount change (handover anti-flap anchor). */
  sinceLastHandoverSec: number;
}

/**
 * Pick the next backing action. Pure: a function of the classification and the
 * runtime context only. Every branch is reachable and carries a reason.
 *
 * The engine layers a live readability probe onto view.umbrelMount.found before
 * calling this (an unreadable umbrelOS mount is not a usable target -> found:false),
 * and only ever ACTS on a "handover"/"bind"/… by then running the matching
 * mutation with the safety rails (section 10).
 */
export function backingDecide(view: BackingView, ctx: BackingDecideCtx): BackingDecision {
  const { mode, drivePresent, graceRemainingSec, plexRunning, sinceLastHandoverSec } = ctx;
  const um = view.umbrelMount;
  const sp = view.stablePath;

  // --- classic mode: v0.1.x direct-mount intent ----------------------------
  // The live monitor keeps classic on the untouched restore path; this branch
  // exists so the ladder is coherent and testable for classic inputs too.
  if (mode === 'classic') {
    if (!drivePresent) return { action: 'none', reason: 'classic: drive absent' };
    if (sp.mounted && sp.direct && !sp.stale) {
      return { action: 'none', reason: 'classic: direct mount is healthy' };
    }
    return { action: 'direct-mount', reason: 'classic: (re)mount the drive by UUID' };
  }

  // --- cooperative mode: A-E -----------------------------------------------
  if (!drivePresent) {
    return { action: 'none', reason: 'drive absent — nothing to back' };
  }

  const correctlyBound =
    sp.bindOfUmbrel &&
    !sp.stale &&
    !sp.boundElsewhere &&
    um.found &&
    view.record?.boundTo === um.path;

  if (um.found) {
    if (correctlyBound) {
      return { action: 'none', reason: 'A: bind active on the live umbrelOS mount' };
    }
    if (sp.direct && !sp.stale) {
      // D: healthy classic direct fallback while an umbrelOS mount is now
      // available — hand over only at a SAFE point, one attempt per cooldown.
      if (sinceLastHandoverSec < HANDOVER_COOLDOWN_SEC) {
        return { action: 'none', reason: 'D: holding direct; a handover was attempted recently (cooldown)' };
      }
      if (!plexRunning) {
        return {
          action: 'handover',
          reason: 'D: umbrelOS mount available and Plex not running — handing over',
        };
      }
      return {
        action: 'none',
        reason: 'D: holding direct (sticky); Plex is live — awaiting a safe point to hand over',
      };
    }
    // A repair: missing / stale bind / bound to an old path / foreign-or-dead
    // mount — (re)bind the stable path to the live umbrelOS mount.
    return { action: 'bind', reason: 'A: (re)bind the stable path to the live umbrelOS mount' };
  }

  // No umbrelMount.
  if (sp.bindOfUmbrel) {
    // E: our bind's umbrelOS source is gone (eject in Files, or umbreld restart);
    // release and await remount — never classic-mount over the user's eject.
    return { action: 'release', reason: 'E: umbrelOS mount gone — releasing our stale bind (awaiting remount)' };
  }
  if (sp.direct && !sp.stale) {
    // C steady state: serving via the classic direct fallback; sticky.
    return { action: 'none', reason: 'C: no umbrelOS mount — serving via the classic direct fallback (sticky)' };
  }
  if (graceRemainingSec > 0) {
    return { action: 'wait', reason: 'B: waiting for umbrelOS to mount the drive' };
  }
  // Grace exhausted. Fall back to a direct mount ONLY inside an arrival flow (a
  // grace window was started by boot/drive-arrival). After an eject we clear
  // graceStartedAt, so we NEVER classic-mount over the user's eject.
  if (view.record?.graceStartedAt != null) {
    return { action: 'direct-mount', reason: 'C: umbrelOS did not mount within the grace window — classic fallback' };
  }
  return { action: 'none', reason: 'E: awaiting umbrelOS remount (do not classic-mount over an eject)' };
}
