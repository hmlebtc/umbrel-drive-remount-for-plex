/**
 * Stateful in-memory HostAdapter (spec sections 9, 10) used for MOCK=1 runs and
 * unit/integration tests. It simulates a real umbrelOS host: a by-uuid device,
 * a mount table (both /proc/1/mounts AND /proc/1/mountinfo), host rootfs files
 * (the pre-start hook, Plex's compose, optional legacy override), media folders
 * on the drive, the Plex container's docker state, AND — new in v0.2.0 — a
 * faithful umbreld coexistence simulation (spec section 0):
 *
 *   (a) umbreld's auto-mounter SKIPS a partition already mounted anywhere (the
 *       lsblk skip rule): while our app holds ANY mount of the raw device,
 *       umbreld never mounts it under <umbrelRoot>/external.
 *   (b) umbreld mounts at <externalBase>/<sanitizedLabel>, and getUniqueName()
 *       appends " (2)"… when a leftover directory already occupies the name
 *       (mount-path drift).
 *   (c) a simulated disk-change event (replug) re-runs umbreld's scan, optionally
 *       renumbering the device (sda1 -> sdb1) so old mounts go dead.
 *   (d) eject (in umbrelOS Files) unmounts umbreld's OWN /External mount.
 *
 * CRITICAL: actions CONVERGE. `mount` adds a fresh (non-stale) mount entry;
 * `umount` removes it; a Plex recreate (`docker compose up`) re-reads the CURRENT
 * compose file and rebuilds the container's binds from it — AND refreshes the
 * container's in-container media view (docker-exec liveness). That is what lets a
 * real restore / switch run in MOCK=1 drive every healable scenario to a
 * genuinely healthy end state.
 *
 * The coexistence scenarios set up an initial host state; deterministic
 * transitions (umbreld mounting late, an eject, a replug, a Plex recreate) are
 * driven by the MockControl methods so tests never depend on wall-clock or tick
 * timing.
 */

import { ensureHookBlock } from './bootHook.js';
import { ensureVolumeLine, parseServiceVolumes } from './composePatch.js';
import type { ExecOptions, ExecResult, HostAdapter, PlexInspect } from './hostAdapter.js';
import { findMount, type MountEntry } from './mounts.js';
import { appDataDir, byUuidPath, composePath, hookPath, hostMediaPath, legacyOverridePath } from './paths.js';
import { defaultSettings } from './settings.js';
import type { ContainerBind, Settings } from './types.js';

export type MockScenario =
  // v0.1.x classic scenarios (unchanged).
  | 'healthy'
  | 'driveAbsent'
  | 'notMounted'
  | 'mountStale'
  | 'bindMissing'
  | 'bindWrongSource'
  | 'composeUnpatched'
  | 'hookMissing'
  | 'plexStopped'
  // v0.2.0 coexistence scenarios (spec section 9).
  | 'coopHealthy'
  | 'umbrelMountsLate'
  | 'umbrelPathDrift'
  | 'umbrelNeverMounts'
  | 'ejectedInUmbrel'
  | 'bindStaleAfterReplug'
  | 'leftoverDirs'
  | 'plexStartedBeforeBind'
  // v0.2.0 fix-hardening hazards (adversarial review F1/F2).
  | 'siblingPartitionMounted'
  // v0.2.1 reclaim scenarios: umbreld drifted to "(2)" behind a leftover at the
  // clean name — an all-empty directory tree (reclaimable) vs. one with a file
  // at depth (has-files; never cleared).
  | 'driftReclaimable'
  | 'driftHasFiles';

/**
 * Test-facing controls to drive the umbreld simulation deterministically. These
 * are the events a real host would produce asynchronously (umbreld finishing its
 * boot scan, a user pressing Eject, a USB re-enumeration, a Plex recreate).
 */
export interface MockControl {
  /** Run umbreld's #mountExternalDevices scan now (respects the lsblk skip rule). */
  simulateUmbreldMount(): void;
  /** Eject in umbrelOS Files: umbreld unmounts its OWN /External mount(s). */
  simulateEject(): void;
  /** USB re-enumeration; `renumber` makes the device come back as a new /dev node. */
  simulateReplug(opts?: { renumber?: boolean }): void;
  /** `docker compose up` equivalent: rebuild binds + refresh the in-container view. */
  recreatePlex(): void;
  /** The live umbrelOS /External mount path of our device, or null. */
  umbrelMountPath(): string | null;
  /** Inject a Plex recreate failure (docker compose up exits non-zero) — for the revert path. */
  setRecreateFails(fails: boolean): void;
  /** Make the sysfs replug unavailable (no USB `authorized` dir) — for the manual-replug path. */
  setReplugAvailable(available: boolean): void;
  /** Disable umbreld's automounter entirely (models a stuck automount). */
  setUmbreldEnabled(enabled: boolean): void;
  /**
   * F1: mark a live mount's target as UNREADABLE (transient EIO) — listDir()
   * returns null even though the mount is live and its source device is present.
   * The proven exploit for the reap-tears-down-a-live-mount hazard.
   */
  setEio(hostPath: string, on: boolean): void;
  /**
   * F5: make `mount` report success (exit 0) WITHOUT actually adding a mount
   * entry — a lying exit code the verify-the-mount-table check must catch.
   */
  setMountSilentlyFails(fails: boolean): void;
  /** Add a directory under the external base (name + whether it holds non-mount files). */
  addExternalDir(name: string, hasFiles?: boolean): void;
  /**
   * v0.2.1: add a node at an absolute path INSIDE the external subtree (a nested
   * directory or a file/symlink/other at depth), so a leftover can model an
   * empty-directory tree or one with a real file. The parent chain is created as
   * directories automatically.
   */
  addSubtreeNode(absPath: string, type: 'dir' | 'file' | 'symlink' | 'other'): void;
}

export interface MockHostAdapter extends HostAdapter, MockControl {
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
/** Legacy scenarios keep the v0.1.x device so their /proc/1/mounts is byte-identical. */
const LEGACY_UUID_DEVICE = '/dev/sdb1';
/** Coexistence scenarios model the live box: LABEL=wdexternal on /dev/sda1 (disk sda). */
const COOP_UUID_DEVICE = '/dev/sda1';
const ROOT_DEVICE = '/dev/sda2';
/** The disk's raw filesystem LABEL (sanitized -> the umbrelOS /External dir name). */
const DRIVE_LABEL = 'wdexternal';
/** A plausible USB device dir the sysfs replug walk (BackingEngine.sysfsReplug) ascends to. */
const USB_DEVICE_DIR = '/sys/devices/pci0000:00/usb1/1-1';

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
    // Coexistence (spec section 9 frozen names).
    'coop-healthy': 'coopHealthy',
    coophealthy: 'coopHealthy',
    'umbrel-mounts-late': 'umbrelMountsLate',
    umbrelmountslate: 'umbrelMountsLate',
    'umbrel-path-drift': 'umbrelPathDrift',
    umbrelpathdrift: 'umbrelPathDrift',
    'umbrel-never-mounts': 'umbrelNeverMounts',
    umbrelnevermounts: 'umbrelNeverMounts',
    'ejected-in-umbrel': 'ejectedInUmbrel',
    ejectedinumbrel: 'ejectedInUmbrel',
    'bind-stale-after-replug': 'bindStaleAfterReplug',
    bindstaleafterreplug: 'bindStaleAfterReplug',
    'leftover-dirs': 'leftoverDirs',
    leftoverdirs: 'leftoverDirs',
    'plex-started-before-bind': 'plexStartedBeforeBind',
    plexstartedbeforebind: 'plexStartedBeforeBind',
    'sibling-partition-mounted': 'siblingPartitionMounted',
    siblingpartitionmounted: 'siblingPartitionMounted',
    'drift-reclaimable': 'driftReclaimable',
    driftreclaimable: 'driftReclaimable',
    'drift-has-files': 'driftHasFiles',
    drifthasfiles: 'driftHasFiles',
  };
  return map[key] ?? null;
}

/** Encode /proc field separators the kernel escapes (space/tab/backslash). */
function encodeMountField(field: string): string {
  return field
    .replace(/\\/g, '\\134')
    .replace(/ /g, '\\040')
    .replace(/\t/g, '\\011');
}

/** Deterministic major:minor for a device node (cosmetic; parseMountInfo drops it). */
function majorMinor(source: string): string {
  const m = /^\/dev\/sd([a-z])(\d+)$/.exec(source);
  if (m) {
    const letter = m[1]!.charCodeAt(0) - 'a'.charCodeAt(0);
    const part = Number(m[2]);
    return `8:${letter * 16 + part}`;
  }
  return '0:0';
}

type MountOwner = 'system' | 'app-direct' | 'app-bind' | 'umbrel';

/** A mount table entry rich enough to synthesize BOTH /proc/1/mounts and mountinfo. */
interface MockMount extends MountEntry {
  mountId: number;
  parentId: number;
  root: string;
  superOptions: string[];
  owner: MountOwner;
}

interface MockState {
  scenario: MockScenario;
  /** True for the v0.2.0 coexistence scenarios. */
  coop: boolean;
  uuidPresent: boolean;
  uuidDevice: string;
  /** Whole-disk node name (for the sysfs replug path), e.g. "sda". */
  disk: string;
  mounts: MockMount[];
  files: Map<string, string>;
  /** Directories under <externalBase>: name (absolute) -> hasFiles (non-mount contents). */
  externalDirs: Map<string, boolean>;
  /**
   * v0.2.1: nodes STRICTLY BELOW a direct child of <externalBase> (grandchildren
   * and deeper) — absolute path -> node type. Direct children live in
   * {@link externalDirs}; this models the nested leftover trees the recursive
   * scan (statType + listDir) walks.
   */
  subtree: Map<string, 'dir' | 'file' | 'symlink' | 'other'>;
  container: {
    exists: boolean;
    running: boolean;
    binds: ContainerBind[];
    /** Container State.StartedAt (ISO), for the bind-generation recreate rule (§5). */
    startedAt: string | null;
    /** What `docker exec <plex> ls <mediaPath>` sees, or null when the path errors. */
    view: string[] | null;
  };
  deviceFolders: Record<string, number>;
  /** Set false only in umbrelNeverMounts so simulateUmbreldMount is inert. */
  umbreldEnabled: boolean;
  /** When true, `docker compose up` fails (recreate revert path). */
  recreateFails: boolean;
  /** When true, the sysfs USB `authorized` dir exists (the replug can be synthesized). */
  replugAvailable: boolean;
  /** F1: mount targets that error on listDir despite being LIVE (transient EIO). */
  eioTargets: Set<string>;
  /** F5: when true, `mount` returns exit 0 but does not add a mount entry. */
  mountSilentlyFails: boolean;
  /**
   * Extra device nodes present on the system beyond the by-uuid device + root
   * (e.g. a foreign drive or a mounted sibling partition). Drives exists() for
   * /dev/* device presence — the F1 reap source-present check.
   */
  extraDevices: Set<string>;
  nextMountId: number;
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

  // --- Path helpers ---------------------------------------------------------

  private externalBase(): string {
    return `${this.s.umbrelRoot}/external`;
  }

  private sanitizedLabel(): string {
    return DRIVE_LABEL.replace(/[^a-zA-Z0-9 '_-]/g, '');
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

  // --- Scenario construction ------------------------------------------------

  private baseState(scenario: MockScenario, coop: boolean, uuidDevice: string): MockState {
    const patched = ensureVolumeLine(BASE_COMPOSE, {
      hostPath: hostMediaPath(this.s),
      containerPath: this.s.containerMediaPath,
    }).text;
    const currentHook = ensureHookBlock(null, {
      uuid: this.s.uuid,
      mountPoint: this.s.mountPoint,
      fsType: this.s.fsType,
      // Coexistence scenarios model a system already IN cooperative mode, whose
      // update-persistent hook is the mkdir-only cooperative block (a classic
      // mount-by-UUID block here would trip umbreld's skip rule at boot and make
      // status.bootHook.ok false — see spec §7). Legacy scenarios keep the
      // v0.1.x classic hook byte-for-byte.
      mountMode: coop ? 'cooperative' : 'classic',
    }).text;
    return {
      scenario,
      coop,
      uuidPresent: true,
      uuidDevice,
      disk: /^\/dev\/(sd[a-z])\d+$/.exec(uuidDevice)?.[1] ?? 'sda',
      mounts: [],
      files: new Map<string, string>([
        [hookPath(this.s), currentHook],
        [composePath(this.s), patched],
        [legacyOverridePath(this.s), LEGACY_OVERRIDE],
      ]),
      externalDirs: new Map<string, boolean>(),
      subtree: new Map<string, 'dir' | 'file' | 'symlink' | 'other'>(),
      container: {
        exists: true,
        running: true,
        binds: this.bindsFromCompose(patched),
        startedAt: new Date().toISOString(),
        view: null,
      },
      deviceFolders: { Movies: 12, TVshows: 8, Music: 20 },
      umbreldEnabled: true,
      recreateFails: false,
      replugAvailable: true,
      eioTargets: new Set<string>(),
      mountSilentlyFails: false,
      extraDevices: new Set<string>(),
      nextMountId: 30,
    };
  }

  private mkMount(
    partial: Omit<MockMount, 'mountId' | 'parentId' | 'root' | 'superOptions'> &
      Partial<Pick<MockMount, 'root' | 'superOptions' | 'parentId'>>,
    state: MockState,
  ): MockMount {
    const ro = partial.options.includes('ro') && !partial.options.includes('rw');
    return {
      mountId: state.nextMountId++,
      parentId: partial.parentId ?? 24,
      root: partial.root ?? '/',
      superOptions: partial.superOptions ?? [ro ? 'ro' : 'rw'],
      source: partial.source,
      target: partial.target,
      fsType: partial.fsType,
      options: partial.options,
      owner: partial.owner,
    };
  }

  private build(scenario: MockScenario): MockState {
    const coop = this.isCoop(scenario);
    return coop ? this.buildCoop(scenario) : this.buildLegacy(scenario);
  }

  private isCoop(scenario: MockScenario): boolean {
    return (
      scenario === 'coopHealthy' ||
      scenario === 'umbrelMountsLate' ||
      scenario === 'umbrelPathDrift' ||
      scenario === 'umbrelNeverMounts' ||
      scenario === 'ejectedInUmbrel' ||
      scenario === 'bindStaleAfterReplug' ||
      scenario === 'leftoverDirs' ||
      scenario === 'plexStartedBeforeBind' ||
      scenario === 'siblingPartitionMounted' ||
      scenario === 'driftReclaimable' ||
      scenario === 'driftHasFiles'
    );
  }

  // --- Legacy (v0.1.x) scenarios — behaviour byte-identical to v0.1.2 -------

  private buildLegacy(scenario: MockScenario): MockState {
    const state = this.baseState(scenario, false, LEGACY_UUID_DEVICE);
    const freshMount = this.mkMount(
      { source: LEGACY_UUID_DEVICE, target: this.s.mountPoint, fsType: this.s.fsType, options: ['rw', 'relatime'], owner: 'app-direct' },
      state,
    );
    state.mounts = [freshMount];
    // v0.1.x containers see the media directly (probeLiveOk = `docker exec ls`
    // exit 0). Keeping the live view means classic scenarios stay liveOk:true,
    // so isHealthy is byte-for-byte what it was before liveOk existed.
    state.container.view = Object.keys(state.deviceFolders);

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
        state.mounts = [
          this.mkMount(
            { source: '/dev/sda1', target: this.s.mountPoint, fsType: this.s.fsType, options: ['rw', 'relatime'], owner: 'app-direct' },
            state,
          ),
        ];
        break;
      case 'bindMissing':
        state.container.binds = this.bindsFromCompose(BASE_COMPOSE);
        break;
      case 'bindWrongSource':
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

  // --- Coexistence (v0.2.0) scenarios ---------------------------------------

  private umbrelMountAt(state: MockState, name: string): MockMount {
    const path = `${this.externalBase()}/${name}`;
    state.externalDirs.set(path, false);
    return this.mkMount(
      { source: state.uuidDevice, target: path, fsType: 'ext4', options: ['rw', 'relatime'], owner: 'umbrel', root: '/' },
      state,
    );
  }

  private appBindAt(state: MockState, source: string): MockMount {
    return this.mkMount(
      { source, target: this.s.mountPoint, fsType: 'ext4', options: ['rw', 'relatime'], owner: 'app-bind', root: '/' },
      state,
    );
  }

  private appDirectAt(state: MockState, source: string): MockMount {
    return this.mkMount(
      { source, target: this.s.mountPoint, fsType: 'ext4', options: ['rw', 'relatime'], owner: 'app-direct', root: '/' },
      state,
    );
  }

  private buildCoop(scenario: MockScenario): MockState {
    const state = this.baseState(scenario, true, COOP_UUID_DEVICE);
    const base = this.externalBase();
    const label = this.sanitizedLabel();

    switch (scenario) {
      case 'coopHealthy': {
        const um = this.umbrelMountAt(state, label);
        state.mounts = [um, this.appBindAt(state, state.uuidDevice)];
        state.container.view = Object.keys(state.deviceFolders);
        break;
      }
      case 'umbrelMountsLate': {
        // Just booted: umbreld has not scanned yet. No /External mount, no bind.
        state.mounts = [];
        state.container.view = null;
        break;
      }
      case 'umbrelPathDrift': {
        // A leftover EMPTY dir occupies the clean name, so umbreld drifted to "(2)".
        state.externalDirs.set(`${base}/${label}`, false);
        const um = this.umbrelMountAt(state, `${label} (2)`);
        state.mounts = [um];
        state.container.view = null;
        break;
      }
      case 'umbrelNeverMounts': {
        // umbreld will not produce an /External mount (simulate a stuck automount).
        state.umbreldEnabled = false;
        state.mounts = [];
        state.container.view = null;
        break;
      }
      case 'ejectedInUmbrel': {
        // Drive present; user pressed Eject in Files -> umbreld's mount is gone,
        // but our recorded bind of it is still up (independent mount).
        state.externalDirs.set(`${base}/${label}`, false);
        state.mounts = [this.appBindAt(state, state.uuidDevice)];
        state.container.view = Object.keys(state.deviceFolders);
        break;
      }
      case 'bindStaleAfterReplug': {
        // Device re-enumerated sda1 -> sdb1. Old umbrel mount + our old bind still
        // reference sda1 (now DEAD). umbreld re-mounted the new device, drifting
        // to "(2)" because the old (dead) name dir still occupies the clean name.
        const dead = '/dev/sda1';
        state.uuidDevice = '/dev/sdb1';
        state.disk = 'sdb';
        state.externalDirs.set(`${base}/${label}`, false);
        const deadUmbrel = this.mkMount(
          { source: dead, target: `${base}/${label}`, fsType: 'ext4', options: ['rw', 'relatime'], owner: 'umbrel', root: '/' },
          state,
        );
        const deadBind = this.mkMount(
          { source: dead, target: this.s.mountPoint, fsType: 'ext4', options: ['rw', 'relatime'], owner: 'app-bind', root: '/' },
          state,
        );
        const liveUmbrel = this.umbrelMountAt(state, `${label} (2)`);
        state.mounts = [deadUmbrel, deadBind, liveUmbrel];
        state.container.view = Object.keys(state.deviceFolders);
        break;
      }
      case 'leftoverDirs': {
        // Hygiene: an empty leftover dir + a foreign dir + a dead-mount dir under
        // the external base, plus a healthy live umbrel mount + bind on "(2)".
        state.externalDirs.set(`${base}/${label}`, false); // empty leftover (reapable)
        state.externalDirs.set(`${base}/someones-backup`, true); // foreign, non-empty (never touch)
        const deadUmbrel = this.mkMount(
          { source: '/dev/sda9', target: `${base}/${label} (3)`, fsType: 'ext4', options: ['rw', 'relatime'], owner: 'umbrel', root: '/' },
          state,
        );
        state.externalDirs.set(`${base}/${label} (3)`, false); // occupied by a dead mount
        const um = this.umbrelMountAt(state, `${label} (2)`);
        state.mounts = [deadUmbrel, um, this.appBindAt(state, state.uuidDevice)];
        state.container.view = Object.keys(state.deviceFolders);
        break;
      }
      case 'siblingPartitionMounted': {
        // F2 (physical safety): the external drive is a WHOLE USB disk (sdc) with
        // our partition sdc1 currently UNmounted, but a sibling partition sdc2 is
        // mounted elsewhere. A partition-scoped guard sees zero mounts of sdc1 and
        // would de-authorize the whole disk — yanking power from live sdc2. The
        // whole-disk guard must veto. Root stays on a DIFFERENT disk (sda) so it
        // is not a false positive.
        state.uuidDevice = '/dev/sdc1';
        state.disk = 'sdc';
        state.extraDevices.add('/dev/sdc2');
        state.mounts = [
          this.mkMount(
            { source: '/dev/sdc2', target: '/mnt/other', fsType: 'ext4', options: ['rw', 'relatime'], owner: 'system', root: '/' },
            state,
          ),
        ];
        state.container.view = null;
        break;
      }
      case 'driftReclaimable': {
        // Cooperative box drifted to "(2)" because a leftover EMPTY-TREE dir
        // (an empty mount-point skeleton, one empty subdir) occupies the clean
        // name. umbreld is mounted at "(2)". The app's cooperative bind is NOT
        // pre-shipped — the reclaim test establishes it via doBind — so classify
        // sees exactly the live box: one /External mount at "(2)" + the leftover.
        // The drive is a SEPARATE USB disk (sdc) from the root disk (sda) so the
        // reclaim's whole-disk sysfs replug is not falsely vetoed by the root fs.
        state.uuidDevice = '/dev/sdc1';
        state.disk = 'sdc';
        state.externalDirs.set(`${base}/${label}`, false); // leftover dir...
        state.subtree.set(`${base}/${label}/skeleton`, 'dir'); // ...with one empty subdir (empty-tree)
        const um = this.umbrelMountAt(state, `${label} (2)`);
        state.mounts = [um];
        state.container.view = Object.keys(state.deviceFolders);
        break;
      }
      case 'driftHasFiles': {
        // As driftReclaimable, but the leftover holds a FILE at depth — it is
        // has-files and must NEVER be cleared; the clean name stays unreclaimable.
        state.uuidDevice = '/dev/sdc1';
        state.disk = 'sdc';
        state.externalDirs.set(`${base}/${label}`, false);
        state.subtree.set(`${base}/${label}/skeleton`, 'dir');
        state.subtree.set(`${base}/${label}/skeleton/movie.mkv`, 'file'); // a real file at depth
        const um = this.umbrelMountAt(state, `${label} (2)`);
        state.mounts = [um];
        state.container.view = Object.keys(state.deviceFolders);
        break;
      }
      case 'plexStartedBeforeBind': {
        // Backing looks correct (umbrel mount + our bind, host media visible) but
        // Plex started BEFORE the bind, so its in-container view is empty/dead.
        const um = this.umbrelMountAt(state, label);
        state.mounts = [um, this.appBindAt(state, state.uuidDevice)];
        // Container started LONG before the bind (bind-generation rule §5) and its
        // in-container view is empty/dead until a recreate re-resolves the source.
        state.container.startedAt = '2026-01-01T00:00:00.000Z';
        state.container.view = []; // docker exec ls -> empty -> liveOk false
        break;
      }
      default:
        break;
    }
    return state;
  }

  // --- umbreld simulation (spec section 0) ----------------------------------

  private rawDeviceIsMounted(state: MockState): boolean {
    // lsblk reports mountpoints of the raw partition: ANY mount of it (ours OR
    // umbreld's own) makes umbreld's auto-mounter `continue` (skip).
    return state.mounts.some((m) => m.source === state.uuidDevice);
  }

  private getUniqueName(state: MockState, base: string): string {
    const full = (name: string): string => `${this.externalBase()}/${name}`;
    if (!state.externalDirs.has(full(base))) return base;
    for (let n = 2; n < 100; n++) {
      const candidate = `${base} (${n})`;
      if (!state.externalDirs.has(full(candidate))) return candidate;
    }
    return `${base} (99)`;
  }

  private umbreldScan(): void {
    const state = this.state;
    if (!state.umbreldEnabled) return;
    if (!state.uuidPresent) return;
    if (this.rawDeviceIsMounted(state)) return; // lsblk skip rule
    const name = this.getUniqueName(state, this.sanitizedLabel());
    state.mounts.push(this.umbrelMountAt(state, name));
  }

  simulateUmbreldMount(): void {
    this.umbreldScan();
  }

  simulateEject(): void {
    const state = this.state;
    state.mounts = state.mounts.filter((m) => m.owner !== 'umbrel');
  }

  simulateReplug(opts: { renumber?: boolean } = {}): void {
    const state = this.state;
    // Surprise removal: the device disappears; existing mounts of it linger DEAD.
    state.uuidPresent = false;
    if (opts.renumber) {
      const nextLetter = String.fromCharCode(state.disk.charCodeAt(state.disk.length - 1) + 1);
      state.disk = `sd${nextLetter}`;
      state.uuidDevice = `/dev/${state.disk}1`;
    }
    // Re-arrival: udev settles, umbreld re-scans on the device-add event.
    state.uuidPresent = true;
    this.umbreldScan();
  }

  recreatePlex(): void {
    this.doRecreate();
  }

  setRecreateFails(fails: boolean): void {
    this.state.recreateFails = fails;
  }

  setReplugAvailable(available: boolean): void {
    this.state.replugAvailable = available;
  }

  setUmbreldEnabled(enabled: boolean): void {
    this.state.umbreldEnabled = enabled;
  }

  setEio(hostPath: string, on: boolean): void {
    if (on) this.state.eioTargets.add(hostPath);
    else this.state.eioTargets.delete(hostPath);
  }

  setMountSilentlyFails(fails: boolean): void {
    this.state.mountSilentlyFails = fails;
  }

  addExternalDir(name: string, hasFiles = false): void {
    this.state.externalDirs.set(`${this.externalBase()}/${name}`, hasFiles);
  }

  addSubtreeNode(absPath: string, type: 'dir' | 'file' | 'symlink' | 'other'): void {
    this.state.subtree.set(absPath, type);
    // Materialize the parent chain as directories down to a direct child of the
    // external base (which lives in externalDirs), so listDir/statType are coherent.
    const base = this.externalBase();
    let parent = absPath.slice(0, absPath.lastIndexOf('/'));
    while (parent.startsWith(`${base}/`)) {
      const rel = parent.slice(base.length + 1);
      if (!rel.includes('/')) {
        if (!this.state.externalDirs.has(parent)) this.state.externalDirs.set(parent, false);
        break;
      }
      if (this.state.subtree.get(parent) !== 'dir') this.state.subtree.set(parent, 'dir');
      parent = parent.slice(0, parent.lastIndexOf('/'));
    }
  }

  /** Immediate child basenames of a modeled external directory (from the subtree). */
  private immediateChildren(path: string): string[] {
    const prefix = `${path}/`;
    const out: string[] = [];
    for (const key of this.state.subtree.keys()) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
        out.push(key.slice(prefix.length));
      }
    }
    return out;
  }

  /** True when `path` is a modeled external directory (direct child or nested). */
  private isModeledDir(path: string): boolean {
    return this.state.externalDirs.has(path) || this.state.subtree.get(path) === 'dir';
  }

  /**
   * Is a /dev/* device node present on the system? True for the by-uuid device
   * (when attached), the root device, and any explicitly-added extra device
   * (foreign drive / mounted sibling partition). Drives the F1 reap source-present
   * check (a zombie's source is ABSENT; a live mount's source — foreign, ours, or
   * ours-under-EIO — is PRESENT).
   */
  private deviceIsPresent(dev: string): boolean {
    if (dev === ROOT_DEVICE) return true;
    if (this.state.uuidPresent && dev === this.state.uuidDevice) return true;
    return this.state.extraDevices.has(dev);
  }

  umbrelMountPath(): string | null {
    const live = this.state.mounts.filter(
      (m) => m.owner === 'umbrel' && m.target.startsWith(`${this.externalBase()}/`) && !this.isDead(m),
    );
    if (live.length === 0) return null;
    // Newest mountId wins (spec section 2).
    return live.reduce((a, b) => (b.mountId > a.mountId ? b : a)).target;
  }

  // --- Liveness helpers -----------------------------------------------------

  /** A mount whose backing device is no longer the live drive is dead/stale. */
  private isDead(m: MockMount): boolean {
    if (m.owner === 'system') return false;
    if (!this.state.uuidPresent) return true;
    return m.source !== this.state.uuidDevice;
  }

  private liveMountAt(path: string): MockMount | null {
    let found: MockMount | null = null;
    for (const m of this.state.mounts) {
      if (m.target === path && !this.isDead(m)) found = m;
    }
    return found;
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

  private mediaHostVisible(): boolean {
    return this.mountedActive();
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

  /**
   * rmdir semantics (real adapter: fs.rmdir — rmdir ONLY): a missing dir is a
   * no-op (ENOENT); a dir that still carries a mount OR non-mount contents fails
   * (ENOTEMPTY); an empty, unmounted dir is removed.
   */
  async removeDir(hostPath: string): Promise<void> {
    const state = this.state;
    const isDir = state.externalDirs.has(hostPath) || state.subtree.get(hostPath) === 'dir';
    if (!isDir) return; // ENOENT (or not-a-directory) -> no-op
    const occupiedByMount = state.mounts.some((m) => m.target === hostPath);
    const hasChildren = this.immediateChildren(hostPath).length > 0; // nested contents
    const legacyHasFiles = state.externalDirs.get(hostPath) === true; // flat "non-empty" flag
    if (occupiedByMount || hasChildren || legacyHasFiles) {
      throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${hostPath}'`), { code: 'ENOTEMPTY' });
    }
    state.externalDirs.delete(hostPath);
    state.subtree.delete(hostPath);
  }

  /**
   * lstat-based node type (v0.2.1): a modeled external directory -> 'dir'; a
   * nested file/symlink/other -> its type; anything else -> null (ENOENT). Does
   * NOT follow symlinks (a subtree 'symlink' stays 'symlink').
   */
  async statType(hostPath: string): Promise<'file' | 'dir' | 'symlink' | 'other' | null> {
    if (hostPath === this.externalBase()) return 'dir';
    if (this.state.externalDirs.has(hostPath)) return 'dir';
    const t = this.state.subtree.get(hostPath);
    return t ?? null;
  }

  async exists(hostPath: string): Promise<boolean> {
    if (hostPath === byUuidPath(this.s)) return this.state.uuidPresent;
    // /dev/* device-node presence (F1 reap source-present check).
    if (/^\/dev\//.test(hostPath)) return this.deviceIsPresent(hostPath);
    if (this.state.externalDirs.has(hostPath)) return true;
    if (this.state.subtree.has(hostPath)) return true; // nested leftover nodes (v0.2.1)
    // sysfs USB device dir attributes the replug walk (sysfsReplug) looks for.
    if (hostPath === `${USB_DEVICE_DIR}/authorized` || hostPath === `${USB_DEVICE_DIR}/idVendor`) {
      return this.state.replugAvailable;
    }
    if (this.isUnderMount(hostPath)) {
      return this.mountedActive() && this.mediaPathExists(hostPath);
    }
    return this.state.files.has(hostPath);
  }

  async listDir(hostPath: string): Promise<string[] | null> {
    const base = this.externalBase();

    // F1: a transient EIO makes a LIVE mount's target unreadable (null) even
    // though the mount is up and its source device is present. (The external
    // base itself is never EIO-marked, so its listing is unaffected.)
    if (hostPath !== base && this.state.eioTargets.has(hostPath)) return null;

    // The external base itself lists its child directory names.
    if (hostPath === base) {
      const prefix = `${base}/`;
      return [...this.state.externalDirs.keys()]
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map((p) => p.slice(prefix.length));
    }

    // A live umbrelOS /External mount reads as the drive root (readability probe).
    const umbrelLive = this.liveMountAt(hostPath);
    if (umbrelLive && umbrelLive.owner === 'umbrel') {
      const sub = this.s.mediaSubdir.trim();
      return sub === '' ? Object.keys(this.state.deviceFolders) : [sub.split('/')[0]!];
    }
    // A dead /External mount dir is unreadable.
    if (
      hostPath.startsWith(`${base}/`) &&
      this.state.mounts.some((m) => m.target === hostPath && this.isDead(m))
    ) {
      return null;
    }

    // v0.2.1: a modeled external directory (an unmounted leftover dir or a nested
    // dir) lists its immediate subtree children — [] for an empty dir.
    if (this.isModeledDir(hostPath)) {
      return this.immediateChildren(hostPath);
    }

    if (!this.isUnderMount(hostPath) || !this.mountedActive()) {
      return this.state.externalDirs.has(hostPath) ? [] : null;
    }
    const mediaRoot = hostMediaPath(this.s);
    if (hostPath === mediaRoot) return Object.keys(this.state.deviceFolders);
    if (hostPath.startsWith(`${mediaRoot}/`)) {
      const rest = hostPath.slice(mediaRoot.length + 1);
      const n = this.state.deviceFolders[rest];
      if (n === undefined) return null;
      return Array.from({ length: n }, (_, i) => `item-${i + 1}`);
    }
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
    // sysfs resolution for the switch job's replug step.
    if (hostPath === `/sys/block/${this.state.disk}`) {
      return `/sys/devices/pci0000:00/usb1/1-1/block/${this.state.disk}`;
    }
    return this.state.files.has(hostPath) ? hostPath : null;
  }

  async readProcMounts(): Promise<string> {
    const lines = [
      'sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0',
      'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
      `${ROOT_DEVICE} / ext4 rw,relatime 0 0`,
    ];
    for (const m of this.state.mounts) {
      lines.push(
        `${encodeMountField(m.source)} ${encodeMountField(m.target)} ${m.fsType} ${m.options.join(',')} 0 0`,
      );
    }
    return `${lines.join('\n')}\n`;
  }

  /**
   * Synthesize /proc/1/mountinfo (spec section 2). Field order per the kernel:
   *   mountId parentId major:minor root mountpoint options <optional…> - fstype source superOptions
   * Includes the pseudo/root mounts an optional-field parser must tolerate.
   */
  async readProcMountInfo(): Promise<string> {
    const lines = [
      '21 24 0:20 / /sys sysfs rw,nosuid,nodev,noexec,relatime shared:2 - sysfs sysfs rw',
      '22 24 0:4 / /proc proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw',
      `24 1 ${majorMinor(ROOT_DEVICE)} / / rw,relatime shared:1 - ext4 ${ROOT_DEVICE} rw,errors=remount-ro`,
    ];
    for (const m of this.state.mounts) {
      const opts = m.options.join(',') || 'rw';
      const sopts = m.superOptions.join(',') || 'rw';
      lines.push(
        `${m.mountId} ${m.parentId} ${majorMinor(m.source)} ${encodeMountField(m.root)} ` +
          `${encodeMountField(m.target)} ${opts} - ${m.fsType} ${encodeMountField(m.source)} ${sopts}`,
      );
    }
    return `${lines.join('\n')}\n`;
  }

  async exec(argv: string[], _opts?: ExecOptions): Promise<ExecResult> {
    const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
    const fail = (code: number, stderr = ''): ExecResult => ({ code, stdout: '', stderr });
    const cmd = argv[0] ?? '';
    const joined = argv.join(' ');

    // In-container liveness: `docker exec <plex> ls <mediaPath>` (spec section 5).
    if (cmd === 'docker' && argv[1] === 'exec') {
      if (!this.state.container.exists || !this.state.container.running) {
        return fail(1, 'mock: container not running');
      }
      const view = this.state.container.view;
      if (view === null) return fail(2, 'ls: cannot access: Input/output error');
      return ok(view.length > 0 ? `${view.join('\n')}\n` : '');
    }

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
      case 'rmdir': {
        const target = argv[argv.length - 1] ?? '';
        try {
          await this.removeDir(target);
          return ok();
        } catch (e) {
          return fail(1, e instanceof Error ? e.message : String(e));
        }
      }
      case 'mountpoint': {
        const target = argv[argv.length - 1] ?? '';
        return this.state.mounts.some((m) => m.target === target) ? ok() : fail(1);
      }
      case 'readlink':
        return this.realpath(argv[argv.length - 1] ?? '').then((r) => (r !== null ? ok(`${r}\n`) : fail(1)));
      case 'docker':
        if (argv.includes('up') || argv.includes('restart')) {
          if (this.state.recreateFails) return fail(1, 'mock: docker compose up failed');
          this.doRecreate();
          return ok('recreated via docker compose');
        }
        return ok();
      case 'hostname':
        return ok(HOSTNAME);
      default:
        // The switch job's rescan step (spec section 6 step 4) synthesizes a
        // replug via sysfs (authorized 0 -> 1, or a driver unbind/bind). The
        // RE-authorize / rebind (or a generic rescan) fires umbreld's device
        // scan; a bare deauthorize (`echo 0`) does not.
        if (/authorized|\/sys\/block|\/bind|udevadm|partprobe|blockdev|rescan/i.test(joined)) {
          if (!/echo\s+0\s*>|\/unbind/i.test(joined)) this.umbreldScan();
          return ok();
        }
        return ok();
    }
  }

  private doMount(argv: string[]): boolean {
    const target = argv[argv.length - 1] ?? '';
    const isBind = argv.includes('--bind');
    const src = argv[argv.length - 2] ?? '';
    const fsIdx = argv.indexOf('-t');
    const fsType = fsIdx !== -1 ? argv[fsIdx + 1] ?? this.s.fsType : this.s.fsType;

    if (isBind) {
      // `mount --bind <umbrelMountPath> <mountPoint>`: our bind of umbreld's mount.
      // The bind shares the source device of whatever fs backs <umbrelMountPath>.
      const srcMount = this.liveMountAt(src);
      const source = srcMount ? srcMount.source : this.state.uuidDevice;
      this.state.mounts = this.state.mounts.filter((m) => m.target !== target);
      this.state.mounts.push(this.appBindAt(this.state, source));
      return true;
    }

    const resolved =
      src === byUuidPath(this.s) ? (this.state.uuidPresent ? this.state.uuidDevice : null) : src;
    if (resolved === null || resolved === '') return false;
    // F5: a lying exit code — report success but do NOT register the mount, so the
    // caller's mount-table verification is what must catch it.
    if (this.state.mountSilentlyFails) return true;
    this.state.mounts = this.state.mounts.filter((m) => m.target !== target);
    this.state.mounts.push(this.appDirectAt(this.state, resolved));
    return true;
  }

  private doRecreate(): void {
    const compText = this.state.files.get(composePath(this.s));
    if (compText) this.state.container.binds = this.bindsFromCompose(compText);
    this.state.container.exists = true;
    this.state.container.running = true;
    this.state.container.startedAt = new Date().toISOString(); // fresh StartedAt
    // Docker resolves bind SOURCES at container start: a recreate re-reads the
    // live backing, so the in-container view now matches host-side reality.
    this.state.container.view = this.mediaHostVisible() ? Object.keys(this.state.deviceFolders) : [];
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
      startedAt: c.exists ? c.startedAt : null,
    };
  }
}

export function createMockAdapter(scenario: MockScenario): MockHostAdapter {
  return new MockHostAdapterImpl(scenario);
}
