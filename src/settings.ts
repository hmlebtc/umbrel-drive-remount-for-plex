/**
 * Persisted settings (spec section 5) — ${DRP_DATA_DIR}/settings.json.
 *
 * On first boot (file absent) settings are seeded from DRP_* env vars, then the
 * saved file always wins — env changes never clobber a live configuration (the
 * "env seeds once" pattern from the OCEAN reference app). Validation rejects
 * anything that could be unsafe when templated into the boot hook or an nsenter
 * argv (bad UUIDs, relative/meta-character paths); numeric auto-heal fields are
 * clamped rather than rejected.
 *
 * SECURITY: a hostile value coming from disk (settings.json) or the environment
 * (DRP_*) must NEVER survive to the boot-hook template or an exec argv. The
 * load/seed/store-init paths therefore run per-field fallback: any field that
 * fails validation is reverted to its defaultSettings() value (and the reset is
 * logged). Only the interactive PUT /api/settings path rejects (400) instead —
 * so the user gets an error rather than a silent revert while editing.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { log } from './log.js';
import type { AutoHealSettings, MountMode, Settings } from './types.js';

export const GRACE_MIN_SEC = 60;
export const GRACE_MAX_SEC = 900;
export const GRACE_DEFAULT_SEC = 180;

// ---------------------------------------------------------------------------
// Defaults — these MUST match the healthy mock host state and B3's compose
// env defaults so a fresh install (and MOCK=1 E2E) is coherent out of the box.
// ---------------------------------------------------------------------------

export function defaultSettings(): Settings {
  return {
    uuid: '555bf6f0-ae17-4137-adec-e91818854f1c',
    fsType: 'ext4',
    mountPoint: '/mnt/wdexternal',
    mediaSubdir: 'media',
    folders: ['Movies', 'TVshows', 'Music'],
    plexAppId: 'plex',
    umbrelRoot: '/home/umbrel/umbrel',
    containerMediaPath: '/media/wdexternal',
    mountMode: 'classic',
    graceSec: 180,
    autoHeal: {
      enabled: true,
      intervalSec: 30,
      cooldownSec: 300,
      maxConsecutiveFailures: 3,
      requireConsecutiveBroken: 2,
    },
  };
}

// ---------------------------------------------------------------------------
// Merge / validation helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  const out: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  for (const [key, patchVal] of Object.entries(patch)) {
    const baseVal = out[key];
    out[key] =
      isPlainObject(patchVal) && isPlainObject(baseVal)
        ? deepMerge(baseVal, patchVal)
        : patchVal;
  }
  return out as T;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

// Canonical RFC-4122-shaped UUID: 8-4-4-4-12 hex groups. Tightened from the old
// loose 36-char [hex + dash] pattern so a value like "aaaa----...------" cannot pass.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const FSTYPE_RE = /^[a-z0-9]+$/;
const ABS_PATH_RE = /^\/[A-Za-z0-9._/-]*$/;
const REL_PATH_RE = /^[A-Za-z0-9._/-]*$/;
const APP_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

const MAX_FOLDERS = 64;
const MAX_FOLDER_NAME = 255;
// A single NUL character, written as a hex escape so this SOURCE file stays
// plain text (no embedded NUL byte -> git treats it as text, not binary).
const NUL = '\x00';

function isAbsSafePath(p: string): boolean {
  return ABS_PATH_RE.test(p) && !p.includes('..');
}

export interface ValidationResult {
  errors: string[];
  /**
   * Top-level field names that failed validation and were reverted to their
   * default value in `settings`. Callers on the load/seed path log these; the
   * PUT path rejects when `errors` is non-empty and ignores this list.
   */
  resetFields: string[];
  settings: Settings;
}

/**
 * Validate + normalise a fully-populated settings object.
 *
 * Every field that fails validation is BOTH reported in `errors` (so the PUT
 * handler can reject) AND reverted to its default value in the returned
 * `settings` with its name recorded in `resetFields` (so the load/seed/init
 * paths can fall back per-field instead of trusting a hostile value). Numeric
 * auto-heal fields are clamped silently (never a hard error).
 */
export function validateSettings(input: Settings): ValidationResult {
  const errors: string[] = [];
  const resetFields: string[] = [];
  const def = defaultSettings();
  const c = deepMerge(def, clone(input)) as Settings;

  const reset = (field: keyof Settings, msg: string): void => {
    errors.push(msg);
    if (!resetFields.includes(field)) resetFields.push(field);
    (c as unknown as Record<string, unknown>)[field] = clone(
      (def as unknown as Record<string, unknown>)[field],
    );
  };

  c.uuid = String(c.uuid ?? '').trim();
  // Empty uuid means "not configured yet" and is allowed to persist as-is.
  if (c.uuid !== '' && !UUID_RE.test(c.uuid)) {
    reset('uuid', 'uuid must be a canonical filesystem UUID (8-4-4-4-12 hex groups)');
  }

  c.fsType = String(c.fsType ?? '').trim();
  if (!FSTYPE_RE.test(c.fsType)) {
    reset('fsType', 'fsType must be a simple lowercase filesystem name (e.g. ext4, exfat, ntfs)');
  }

  c.mountPoint = String(c.mountPoint ?? '').trim();
  if (!isAbsSafePath(c.mountPoint)) {
    reset('mountPoint', 'mountPoint must be an absolute path with no spaces or shell metacharacters');
  }

  c.containerMediaPath = String(c.containerMediaPath ?? '').trim();
  if (!isAbsSafePath(c.containerMediaPath)) {
    reset('containerMediaPath', 'containerMediaPath must be an absolute path with no spaces or shell metacharacters');
  }

  c.mediaSubdir = String(c.mediaSubdir ?? '').trim();
  if (c.mediaSubdir !== '' && (!REL_PATH_RE.test(c.mediaSubdir) || c.mediaSubdir.includes('..') || c.mediaSubdir.startsWith('/'))) {
    reset('mediaSubdir', 'mediaSubdir must be a relative subpath (no leading slash, no ..)');
  }

  c.plexAppId = String(c.plexAppId ?? '').trim();
  if (!APP_ID_RE.test(c.plexAppId)) {
    reset('plexAppId', 'plexAppId must be a lowercase Umbrel app id (a-z, 0-9, dashes)');
  }

  c.umbrelRoot = String(c.umbrelRoot ?? '').trim();
  if (!isAbsSafePath(c.umbrelRoot)) {
    reset('umbrelRoot', 'umbrelRoot must be an absolute path with no spaces or shell metacharacters');
  }

  c.mountMode = String(c.mountMode ?? '').trim() as MountMode;
  if (c.mountMode !== 'classic' && c.mountMode !== 'cooperative') {
    reset('mountMode', 'mountMode must be "classic" or "cooperative"');
  }

  // graceSec is clamped (never a hard error), mirroring the auto-heal numerics.
  c.graceSec = clampInt(c.graceSec, GRACE_MIN_SEC, GRACE_MAX_SEC, GRACE_DEFAULT_SEC);

  if (!Array.isArray(c.folders)) {
    reset('folders', 'folders must be a non-empty array of media folder names');
  } else {
    const cleaned = c.folders.map((f) => String(f).trim()).filter((f) => f !== '');
    let bad = false;
    if (cleaned.length === 0) {
      errors.push('folders must contain at least one media folder name');
      bad = true;
    }
    if (cleaned.length > MAX_FOLDERS) {
      errors.push(`folders cannot exceed ${MAX_FOLDERS} entries`);
      bad = true;
    }
    for (const f of cleaned) {
      if (
        f.includes('/') ||
        f.includes('..') ||
        f.includes('\n') ||
        f.includes(NUL) ||
        f.includes(' ') ||
        f.length > MAX_FOLDER_NAME
      ) {
        errors.push(`folder name is invalid: ${JSON.stringify(f)}`);
        bad = true;
      }
    }
    if (bad) {
      if (!resetFields.includes('folders')) resetFields.push('folders');
      c.folders = clone(def.folders);
    } else {
      c.folders = cleaned;
    }
  }

  const ah: AutoHealSettings = {
    enabled: Boolean(c.autoHeal?.enabled),
    intervalSec: clampInt(c.autoHeal?.intervalSec, 10, 3600, 30),
    cooldownSec: clampInt(c.autoHeal?.cooldownSec, 60, 86_400, 300),
    maxConsecutiveFailures: clampInt(c.autoHeal?.maxConsecutiveFailures, 1, 100, 3),
    requireConsecutiveBroken: clampInt(c.autoHeal?.requireConsecutiveBroken, 1, 100, 2),
  };
  c.autoHeal = ah;

  return { errors, resetFields, settings: c };
}

/**
 * Load/seed/init path: validate with per-field fallback and LOG any field that
 * was reverted to its default (so a hostile settings.json/DRP_* value can never
 * silently reach the boot hook or an exec argv). Returns the safe settings.
 */
function sanitizeSettings(input: Settings, source: string): Settings {
  const { settings, resetFields } = validateSettings(input);
  if (resetFields.length > 0) {
    log(
      `settings: ${resetFields.length} invalid field(s) reset to defaults ` +
        `(${resetFields.join(', ')}) [source: ${source}]`,
    );
  }
  return settings;
}

// ---------------------------------------------------------------------------
// First-boot env seeding (DRP_* — must match the compose env names in
// hmlebtc-drive-remount-for-plex/docker-compose.yml).
// ---------------------------------------------------------------------------

function envBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return undefined;
}

export function seedSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): Settings {
  const c = defaultSettings();

  if (env.DRP_UUID) c.uuid = env.DRP_UUID;
  if (env.DRP_FSTYPE) c.fsType = env.DRP_FSTYPE;
  if (env.DRP_MOUNT_POINT) c.mountPoint = env.DRP_MOUNT_POINT;
  if (env.DRP_MEDIA_SUBDIR !== undefined) c.mediaSubdir = env.DRP_MEDIA_SUBDIR;
  if (env.DRP_FOLDERS) c.folders = env.DRP_FOLDERS.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (env.DRP_PLEX_APP_ID) c.plexAppId = env.DRP_PLEX_APP_ID;
  if (env.DRP_UMBREL_ROOT) c.umbrelRoot = env.DRP_UMBREL_ROOT;
  if (env.DRP_CONTAINER_MEDIA_PATH) c.containerMediaPath = env.DRP_CONTAINER_MEDIA_PATH;
  if (env.DRP_MOUNT_MODE) c.mountMode = env.DRP_MOUNT_MODE.trim() as MountMode;
  if (env.DRP_GRACE_SECONDS) c.graceSec = Number(env.DRP_GRACE_SECONDS);

  const enabled = envBool(env.DRP_AUTOHEAL_ENABLED);
  if (enabled !== undefined) c.autoHeal.enabled = enabled;
  if (env.DRP_AUTOHEAL_INTERVAL_SECONDS) c.autoHeal.intervalSec = Number(env.DRP_AUTOHEAL_INTERVAL_SECONDS);
  if (env.DRP_AUTOHEAL_COOLDOWN_SECONDS) c.autoHeal.cooldownSec = Number(env.DRP_AUTOHEAL_COOLDOWN_SECONDS);
  if (env.DRP_AUTOHEAL_REQUIRE_CONSECUTIVE_BROKEN) {
    c.autoHeal.requireConsecutiveBroken = Number(env.DRP_AUTOHEAL_REQUIRE_CONSECUTIVE_BROKEN);
  }
  if (env.DRP_AUTOHEAL_MAX_CONSECUTIVE_FAILURES) {
    c.autoHeal.maxConsecutiveFailures = Number(env.DRP_AUTOHEAL_MAX_CONSECUTIVE_FAILURES);
  }

  // Normalise + fall back per field so a bad env value can't produce an invalid
  // persisted file or reach a template.
  return sanitizeSettings(c, 'env');
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function settingsPath(dataDir: string): string {
  return join(dataDir, 'settings.json');
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, path);
}

export function saveSettings(dataDir: string, settings: Settings): void {
  atomicWriteJson(settingsPath(dataDir), settings);
}

export function loadSettings(dataDir: string, env: NodeJS.ProcessEnv = process.env): Settings {
  const path = settingsPath(dataDir);
  if (!existsSync(path)) {
    const seeded = seedSettingsFromEnv(env);
    saveSettings(dataDir, seeded);
    return seeded;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return defaultSettings();
  }
  return sanitizeSettings(deepMerge(defaultSettings(), parsed), 'settings.json');
}

/**
 * Mutable holder so a live PUT is reflected everywhere current settings are
 * read via get(). update() validates + persists + applies, returning either
 * {ok:true} or {ok:false, errors:[...]} (no partial application on error).
 */
export class SettingsStore {
  private current: Settings;

  constructor(private readonly dataDir: string, initial?: Settings) {
    this.current = initial ? sanitizeSettings(initial, 'store-init') : loadSettings(dataDir);
  }

  get(): Settings {
    return this.current;
  }

  update(patch: Partial<Settings>): { ok: true } | { ok: false; errors: string[] } {
    const merged = deepMerge(this.current, patch);
    const { errors, settings } = validateSettings(merged);
    if (errors.length > 0) return { ok: false, errors };
    this.current = settings;
    try {
      saveSettings(this.dataDir, settings);
    } catch {
      /* keep the in-memory update even if persistence fails */
    }
    return { ok: true };
  }
}
