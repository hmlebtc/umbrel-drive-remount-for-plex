/**
 * Stateful in-memory HostAdapter (spec sections 9, 10) used for MOCK=1 runs and
 * unit/integration tests. It simulates a real umbrelOS host: a by-uuid device,
 * a mount table, host rootfs files (the pre-start hook, Plex's compose,
 * optional legacy override), media folders on the drive, and the Plex
 * container's docker state.
 *
 * CRITICAL: actions CONVERGE. `mount` adds a fresh (non-stale) mount entry;
 * `umount` removes it; a Plex recreate (`docker compose up`)
 * re-reads the CURRENT compose file and rebuilds the container's binds from it —
 * so once composePatch has written the media bind, a recreate makes the
 * container actually carry it. That is what lets a real restore run in MOCK=1
 * drive every healable scenario to a genuinely healthy end state.
 */

import { ensureHookBlock } from './bootHook.js';
import { ensureVolumeLine, parseServiceVolumes } from './composePatch.js';
import type { ExecOptions, ExecResult, HostAdapter, PlexInspect } from './hostAdapter.js';
import { findMount, type MountEntry } from './mounts.js';
import { appDataDir, byUuidPath, composePath, hookPath, hostMediaPath, legacyOverridePath } from './paths.js';
import { defaultSettings } from './settings.js';
import type { ContainerBind, Settings } from './types.js';

export type MockScenario =
  | 'healthy'
  | 'driveAbsent'
  | 'notMounted'
  | 'mountStale'
  | 'bindMissing'
  | 'bindWrongSource'
  | 'composeUnpatched'
  | 'hookMissing'
  | 'plexStopped';

export interface MockHostAdapter extends HostAdapter {
  setScenario(scenario: MockScenario | string): void;
  getScenario(): MockScenario;
}

/** umbreld-installed (unpatched) Plex compose — freshly installed shape. */
const BASE_COMPOSE = `version: "3.7"

services:
  server:
    image: umbrel/plex:1.32.8
    container_name: plex_server_1
    network_mode: host
    hostname: \${DEVICE_HOSTNAME}
    restart: on-failure
    volumes:
      - \${APP_DATA_DIR}/data/config:/config
      - \${APP_DATA_DIR}/data/transcode:/transcode
      - \${UMBREL_ROOT}/home/Downloads:/downloads
    environment:
      TZ: UTC
`;

/**
 * A leftover, user-authored override from a previous manual solution. umbreld
 * IGNORES override files entirely (it starts apps with explicit --file flags),
 * so this is inert — but the mock ships it present (mirroring the user's real
 * box) so composePatch.legacyOverridePresent is true by default and the
 * "remove legacy override" action is exercisable end-to-end.
 */
const LEGACY_OVERRIDE = `services:
  server:
    volumes:
      - /mnt/wdexternal/media:/media
`;

const HOSTNAME = 'umbrel-mock';
const UUID_DEVICE = '/dev/sdb1';

function normalizeScenario(raw: string): MockScenario | null {
  const key = raw.trim().toLowerCase();
  const map: Record<string, MockScenario> = {
    healthy: 'healthy',
    'drive-unplugged': 'driveAbsent',
    driveunplugged: 'driveAbsent',
    'drive-absent': 'driveAbsent',
    driveabsent: 'driveAbsent',
    'not-mounted': 'notMounted',
    notmounted: 'notMounted',
    'mount-stale': 'mountStale',
    mountstale: 'mountStale',
    'bind-missing': 'bindMissing',
    bindmissing: 'bindMissing',
    'bind-wrong-source': 'bindWrongSource',
    bindwrongsource: 'bindWrongSource',
    'compose-unpatched': 'composeUnpatched',
    composeunpatched: 'composeUnpatched',
    'hook-missing': 'hookMissing',
    hookmissing: 'hookMissing',
    'plex-stopped': 'plexStopped',
    plexstopped: 'plexStopped',
  };
  return map[key] ?? null;
}

function encodeMountField(field: string): string {
  return field
    .replace(/\\/g, '\\134')
    .replace(/ /g, '\\040')
    .replace(/\t/g, '\\011');
}

interface MockState {
  scenario: MockScenario;
  uuidPresent: boolean;
  uuidDevice: string;
  mounts: MountEntry[];
  files: Map<string, string>;
  container: { exists: boolean; running: boolean; binds: ContainerBind[] };
  deviceFolders: Record<string, number>;
}

class MockHostAdapterImpl implements MockHostAdapter {
  private readonly s: Settings = defaultSettings();
  private state!: MockState;

  constructor(scenario: MockScenario) {
    this.setScenario(scenario);
  }

  getScenario(): MockScenario {
    return this.state.scenario;
  }

  setScenario(raw: MockScenario | string): void {
    const scenario = normalizeScenario(raw);
    if (scenario === null) throw new Error(`unknown mock scenario: ${raw}`);
    this.state = this.build(scenario);
  }

  private substituteEnv(value: string): string {
    return value
      .replace(/\$\{APP_DATA_DIR\}/g, appDataDir(this.s))
      .replace(/\$\{UMBREL_ROOT\}/g, this.s.umbrelRoot)
      .replace(/\$\{DEVICE_HOSTNAME\}/g, HOSTNAME);
  }

  private bindsFromCompose(composeText: string): ContainerBind[] {
    return parseServiceVolumes(composeText, 'server').map((v) => ({
      source: this.substituteEnv(v.source),
      destination: v.destination,
    }));
  }

  private build(scenario: MockScenario): MockState {
    const patched = ensureVolumeLine(BASE_COMPOSE, {
      hostPath: hostMediaPath(this.s),
      containerPath: this.s.containerMediaPath,
    }).text;
    const currentHook = ensureHookBlock(null, {
      uuid: this.s.uuid,
      mountPoint: this.s.mountPoint,
      fsType: this.s.fsType,
    }).text;

    const freshMount: MountEntry = {
      source: UUID_DEVICE,
      target: this.s.mountPoint,
      fsType: this.s.fsType,
      options: ['rw', 'relatime'],
    };

    const state: MockState = {
      scenario,
      uuidPresent: true,
      uuidDevice: UUID_DEVICE,
      mounts: [{ ...freshMount }],
      files: new Map<string, string>([
        [hookPath(this.s), currentHook],
        [composePath(this.s), patched],
        [legacyOverridePath(this.s), LEGACY_OVERRIDE],
      ]),
      container: { exists: true, running: true, binds: this.bindsFromCompose(patched) },
      deviceFolders: { Movies: 12, TVshows: 8, Music: 20 },
    };

    switch (scenario) {
      case 'healthy':
        break;
      case 'driveAbsent':
        state.uuidPresent = false;
        state.mounts = [];
        break;
      case 'notMounted':
        state.mounts = [];
        break;
      case 'mountStale':
        // Mounted, but the backing device no longer matches the live by-uuid
        // device (drive re-enumerated after a replug).
        state.mounts = [
          { source: '/dev/sda1', target: this.s.mountPoint, fsType: this.s.fsType, options: ['rw', 'relatime'] },
        ];
        break;
      case 'bindMissing':
        // Compose IS patched, but the running container predates the patch.
        state.container.binds = this.bindsFromCompose(BASE_COMPOSE);
        break;
      case 'bindWrongSource':
        // Compose IS patched and the container has a bind to the right
        // destination, but its host source is STALE (e.g. an old mount path) —
        // must be treated as bind-missing (media not actually visible).
        state.container.binds = this.bindsFromCompose(BASE_COMPOSE).concat({
          source: '/mnt/OLDPATH/media',
          destination: this.s.containerMediaPath,
        });
        break;
      case 'composeUnpatched':
        state.files.set(composePath(this.s), BASE_COMPOSE);
        state.container.binds = this.bindsFromCompose(BASE_COMPOSE);
        break;
      case 'hookMissing':
        state.files.delete(hookPath(this.s));
        break;
      case 'plexStopped':
        state.container.running = false;
        break;
    }
    return state;
  }

  private isUnderMount(p: string): boolean {
    const mp = this.s.mountPoint;
    return p === mp || p.startsWith(`${mp}/`);
  }

  private mountedActive(): boolean {
    const entry = findMount(this.state.mounts, this.s.mountPoint);
    if (!entry) return false;
    if (!this.state.uuidPresent) return false;
    return entry.source === this.state.uuidDevice;
  }

  private mediaPathExists(p: string): boolean {
    const mediaRoot = hostMediaPath(this.s);
    if (p === this.s.mountPoint || p === mediaRoot) return true;
    if (p.startsWith(`${mediaRoot}/`)) {
      const rest = p.slice(mediaRoot.length + 1);
      return Object.prototype.hasOwnProperty.call(this.state.deviceFolders, rest);
    }
    return false;
  }

  // --- HostAdapter ----------------------------------------------------------

  async readFile(hostPath: string): Promise<string | null> {
    return this.state.files.get(hostPath) ?? null;
  }

  async writeFileAtomic(hostPath: string, content: string): Promise<void> {
    this.state.files.set(hostPath, content);
  }

  async removeFile(hostPath: string): Promise<void> {
    this.state.files.delete(hostPath); // Map.delete is a no-op when absent
  }

  async exists(hostPath: string): Promise<boolean> {
    if (hostPath === byUuidPath(this.s)) return this.state.uuidPresent;
    if (this.isUnderMount(hostPath)) {
      return this.mountedActive() && this.mediaPathExists(hostPath);
    }
    return this.state.files.has(hostPath);
  }

  async listDir(hostPath: string): Promise<string[] | null> {
    if (!this.isUnderMount(hostPath) || !this.mountedActive()) return null;
    const mediaRoot = hostMediaPath(this.s);
    if (hostPath === mediaRoot) return Object.keys(this.state.deviceFolders);
    if (hostPath.startsWith(`${mediaRoot}/`)) {
      const rest = hostPath.slice(mediaRoot.length + 1);
      const n = this.state.deviceFolders[rest];
      if (n === undefined) return null;
      return Array.from({ length: n }, (_, i) => `item-${i + 1}`);
    }
    // The mount root itself lists as the top of the drive (the media subdir, or
    // the media folders directly when mediaSubdir is empty). This makes the
    // status/restore "mount target readable" (EIO) probe see a live mount as
    // readable — and a stale mount (mountedActive() false, above) as null.
    if (hostPath === this.s.mountPoint) {
      const sub = this.s.mediaSubdir.trim();
      return sub === '' ? Object.keys(this.state.deviceFolders) : [sub.split('/')[0]!];
    }
    return null;
  }

  async realpath(hostPath: string): Promise<string | null> {
    if (hostPath === byUuidPath(this.s)) {
      return this.state.uuidPresent ? this.state.uuidDevice : null;
    }
    return this.state.files.has(hostPath) ? hostPath : null;
  }

  async readProcMounts(): Promise<string> {
    const lines = [
      'sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0',
      'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
      '/dev/sda2 / ext4 rw,relatime 0 0',
    ];
    for (const m of this.state.mounts) {
      lines.push(
        `${encodeMountField(m.source)} ${encodeMountField(m.target)} ${m.fsType} ${m.options.join(',')} 0 0`,
      );
    }
    return `${lines.join('\n')}\n`;
  }

  async exec(argv: string[], _opts?: ExecOptions): Promise<ExecResult> {
    const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
    const fail = (code: number, stderr = ''): ExecResult => ({ code, stdout: '', stderr });
    const cmd = argv[0] ?? '';

    switch (cmd) {
      case 'mount':
        return this.doMount(argv) ? ok('mounted') : fail(32, 'mock: drive not present');
      case 'umount': {
        const target = argv[argv.length - 1] ?? '';
        this.state.mounts = this.state.mounts.filter((m) => m.target !== target);
        return ok();
      }
      case 'mkdir':
        return ok();
      case 'mountpoint': {
        const target = argv[argv.length - 1] ?? '';
        return this.state.mounts.some((m) => m.target === target) ? ok() : fail(1);
      }
      case 'docker':
        if (argv.includes('up') || argv.includes('restart')) {
          this.doRecreate();
          return ok('recreated via docker compose');
        }
        return ok();
      case 'hostname':
        return ok(HOSTNAME);
      default:
        return ok();
    }
  }

  private doMount(argv: string[]): boolean {
    const target = argv[argv.length - 1] ?? '';
    const device = argv[argv.length - 2] ?? '';
    const fsIdx = argv.indexOf('-t');
    const fsType = fsIdx !== -1 ? argv[fsIdx + 1] ?? this.s.fsType : this.s.fsType;
    const resolved = device === byUuidPath(this.s) ? (this.state.uuidPresent ? this.state.uuidDevice : null) : device;
    if (resolved === null || resolved === '') return false;
    this.state.mounts = this.state.mounts.filter((m) => m.target !== target);
    this.state.mounts.push({ source: resolved, target, fsType, options: ['rw', 'relatime'] });
    return true;
  }

  private doRecreate(): void {
    const compText = this.state.files.get(composePath(this.s));
    if (compText) this.state.container.binds = this.bindsFromCompose(compText);
    this.state.container.exists = true;
    this.state.container.running = true;
  }

  async hostname(): Promise<string> {
    return HOSTNAME;
  }

  async inspectPlex(plexAppId: string): Promise<PlexInspect> {
    const c = this.state.container;
    return {
      found: c.exists,
      containerName: c.exists ? `${plexAppId}_server_1` : null,
      state: c.exists ? (c.running ? 'running' : 'exited') : null,
      binds: c.binds,
    };
  }
}

export function createMockAdapter(scenario: MockScenario): MockHostAdapter {
  return new MockHostAdapterImpl(scenario);
}
