<img src="assets/icon-512.png" alt="Drive Remount for Plex icon" width="96" height="96">

# Drive Remount for Plex

An [Umbrel](https://umbrel.com/) app that keeps an external USB drive's media folder permanently visible to
[Plex](https://www.plex.tv/), across umbrelOS updates, Plex app updates, USB reconnects, and reboots. It
replaces a fragile, hand-maintained pile of host-side artifacts - an `/etc/fstab` entry, a udev rule, a
systemd unit, `/usr/local/bin` scripts, and a `docker-compose.override.yml` - with one always-running
privileged app container that watches the whole chain and repairs it when it breaks.

## The problem

Three separate things on umbrelOS conspire to make an external drive's media folder disappear from Plex
sooner or later, and none of the obvious fixes actually stick:

- **`docker-compose.override.yml` is invisible to Plex.** umbreld starts every app with an explicit list of
  compose files (an `app_proxy` fragment if defined, Tor if enabled, a common file, then the app's own
  `docker-compose.yml`) passed via `--file` flags. `docker-compose.override.yml` is never referenced
  anywhere in umbreld's app-launch code, so a hand-added override that adds a volume to Plex is silently
  ignored the moment umbreld (re)starts the container.
- **A manual `/etc/fstab` entry gets wiped.** umbrelOS updates itself by swapping between two OS partitions
  (A/B slots, via Rugix); only `/data` (the persistent partition) survives an update. `/etc/fstab` lives on
  the OS root filesystem, so any line you add to it is gone the next time umbrelOS updates - and a stale
  or malformed entry has been known to confuse umbrelOS's own disk detection on top of that.
- **umbrelOS's own USB auto-mount path drifts.** Plugging in a USB drive gets it auto-mounted under
  `<UMBREL_ROOT>/external/<label>` for the Files app / Samba - convenient for browsing, but that mount is a
  Files-app feature, not something any other app's compose file can reference, and a reconnect can land the
  same drive at a different path with a `" (2)"` collision suffix if the previous mount wasn't cleanly
  released.

## How it works

The app container **is** the persistence mechanism: Umbrel's app-data directory survives OS updates, and
umbreld restarts apps after updates and reboots, so as long as the container itself keeps doing its job on
every start, the fixes it applies keep re-applying themselves. The only artifact that has to survive on the
host, outside the container, is the boot-time mount - and umbrelOS has an officially supported,
update-persistent hook for exactly that.

Since v0.2.0 there are two mount modes, chosen by the `mountMode` setting (`classic`, the default, or
`cooperative`); the numbered list below describes the shared machinery, and the boot hook step is mode-aware
as noted. See [Using the drive with umbrelOS Files (cooperative mode)](#using-the-drive-with-umbrelos-files-cooperative-mode)
for what changes in cooperative mode and why you'd want it.

1. **Boot hook** (`<UMBREL_ROOT>/custom-hooks/pre-start`) - umbrelOS runs this script on every boot, after
   `local-fs.target`/`network-online.target` and before `umbreld` itself starts (via the
   `umbrel-custom-pre-start.service` unit, 5-minute timeout, must be executable). Because it lives on the
   persistent partition, it survives OS updates the way `/etc/fstab` never could. The app manages a single
   marked block inside this file (`# BEGIN drive-remount-for-plex` / `# END`) that is re-rendered whenever
   the mode changes. In **classic mode** the block is unchanged from v0.1.x: it waits up to ~30 seconds for
   the drive to enumerate under `/dev/disk/by-uuid` (USB udev settle), then makes one best-effort direct
   mount attempt by filesystem UUID (`mount ... || true`). In **cooperative mode** the block only creates
   the mount point directory (`mkdir -p <mountPoint>`) and deliberately does *not* mount the raw device at
   boot - doing so would make umbrelOS's own auto-mounter skip the drive at its boot-time scan (see the
   cooperative-mode section below), which would defeat the whole point of the mode. Either way, foreign
   content in the file is always preserved, never overwritten, and the hook never blocks or fails boot; if
   the drive (classic) or umbrelOS's own mount (cooperative) still isn't up once the container starts, the
   app's own monitor picks up from there.
2. **Compose patch** (`<UMBREL_ROOT>/app-data/<plexAppId>/docker-compose.yml`) - the app inserts one volume
   line into Plex's *installed* compose file, not the pristine store copy. This works, where an override
   wouldn't, because umbreld's `patchComposeFile()` re-serializes and force-injects `container_name` into
   this exact file on every install/update/start, and its YAML round-trip preserves extra volume entries -
   so umbreld's own restart of Plex keeps the bind. Only a Plex *app update* re-copies the pristine file and
   drops the patch; the monitor (below) detects that and re-heals it. This volume line is identical in both
   modes - it always points at the same stable `<mountPoint>`, regardless of what backs that path.
3. **The mount itself** - in classic mode, `mount -t <fsType> /dev/disk/by-uuid/<uuid> <mountPoint>`, run at
   runtime through `nsenter` for on-demand healing (the boot hook covers the reboot case). In cooperative
   mode this step is replaced by a small state machine (the "backing ladder") that binds `<mountPoint>` to
   umbrelOS's own live mount instead of mounting the raw device directly - see the cooperative-mode section
   below for how it works. The app never touches `/etc/fstab` in either mode; if it finds a legacy fstab
   entry for the same drive, it reports it informationally and leaves it alone.
4. **Monitor + auto-heal** - a background loop (default every 30s) checks all of the above plus the running
   Plex container's actual bind (via the Docker Engine API) and the media folders' presence, and can
   trigger a full restore automatically when something's broken, debounced against transient states and
   rate-limited by a cooldown. It only recreates the Plex container when the container is actually missing
   the bind - a drifted hook or compose patch on an otherwise healthy, already-bound Plex is repaired
   silently, with zero Plex downtime. In cooperative mode the same loop also drives the backing ladder and
   checks Plex's *in-container* liveness (whether the media folder actually lists inside the running
   container), not just its config-level bind, since Docker only resolves a bind's source at container
   start - a re-point of the bind after Plex is already running needs that extra check to catch.
5. **Dashboard** - status tiles for each of the checks above, one-click "Run Full Restore" and "Restart
   Plex", a live job log, activity history, and a settings form - all behind Umbrel's own session login via
   `app_proxy`. Cooperative mode adds a "Backing" detail to the mount tile and "Switch to cooperative
   mode" / "Switch to classic mode" actions - see below.

## Using the drive with umbrelOS Files (cooperative mode)

### Why umbrelOS Files shows "Format Required" in classic mode

In classic mode (the default, and the only mode before v0.2.0) this app mounts the drive directly by
filesystem UUID at `<mountPoint>`, outside of anywhere umbrelOS's own Files app looks. That makes umbrelOS's
Files app show a **"Format Required"** prompt for the drive, even though it's mounted, healthy, and actively
serving Plex. This is cosmetic, not a sign of a problem, and it comes from two specific things in umbrelOS
itself (`getumbrel/umbrel`, verified against `master` and a live box):

- The Files UI decides whether to show the Format prompt with `requiresFormat = !drive.isMounted`
  (`format-drive-dialog/index.tsx`). `isMounted` is true **only** when umbrelOS's own auto-mounter has
  mounted the partition under `<UMBREL_ROOT>/external/` (`external-storage.ts`) - it is not a real
  filesystem probe, so it has no way to know the drive is actually mounted somewhere else.
- umbrelOS's auto-mounter, in turn, explicitly **skips** any partition that already has a mount anywhere on
  the system (`if (partition.mountpoints.length > 0) continue`, `external-storage.ts`) - it only scans
  `lsblk` output for mountpoints, it doesn't check where they are. So the moment this app mounts the drive
  directly for Plex, umbrelOS's auto-mounter permanently skips it too, and the Files UI is stuck showing
  "Format Required" for as long as the drive stays in classic mode.

> **Do not click "Format" on this drive in the umbrelOS Files app.** Your data is intact - Plex is reading
> it right now. umbrelOS's Format action is a real, destructive `sgdisk --zap-all` + `wipefs -a` +
> repartition + `mkfs`, and it is the *only* thing on umbrelOS that can actually destroy the data on this
> drive. This app never triggers it, and never will; it exists purely as a manual, user-clicked action
> inside umbrelOS's own dialog. If you want the "Format Required" prompt gone instead of just ignored,
> switch to cooperative mode below - do not use the Format button to try to fix it.

The app shows the same warning on the dashboard whenever it detects this situation (the `FORMAT_DIALOG_EXPECTED`
status warning), as a standing reminder for as long as you stay in classic mode.

### What cooperative mode does

Cooperative mode (`mountMode: "cooperative"`) flips who owns the "real" mount: instead of this app mounting
the raw device directly, it lets **umbrelOS's own auto-mounter** mount the drive under
`<UMBREL_ROOT>/external/<label>` (the same mount Files and Samba use), and then binds the app's stable
`<mountPoint>` - the one path Plex is always configured against - on top of that live mount
(`mount --bind <umbrelMount> <mountPoint>`). Because umbrelOS now holds the only real mount, its auto-mounter
no longer skips the drive, and the Files "Format Required" prompt goes away; Files, Samba, and Plex all read
the same drive at the same time.

Keeping that bind correct across USB reconnects, umbrelOS updates that move the mount path, power loss, and
umbrelOS's own `" (2)"` name-collision drift is handled by a small state machine (the "backing ladder") that
the monitor runs on every check, in addition to the existing checks:

- **umbrelOS's mount is present and healthy** -> ensure `<mountPoint>` is bound to exactly that path;
  re-bind if it's missing, stale, or pointing at the wrong place.
- **umbrelOS hasn't mounted it yet** -> wait, up to a grace period (default 180 seconds, configurable
  60-900s via the `graceSec` setting), while reaping stale leftovers (below) so umbrelOS can claim the clean
  name instead of drifting to `<label> (2)`.
- **umbrelOS still hasn't mounted it after the grace period** -> fall back to a classic direct mount so
  Plex is never left without media. This fallback is sticky: the app won't keep retrying automatically, only
  on the next drive (re)connection or an explicit user action, to avoid flapping.
- **umbrelOS's mount appears later, while the app is on the fallback** -> switch over to the bind at the
  next safe point (a drive reconnect, an explicit user action, or a moment when the Plex container isn't
  running), rather than disrupting Plex mid-stream.
- **umbrelOS's mount disappears while the drive is still physically present** (typically: you clicked
  "Eject" in Files, or umbreld itself restarted) -> release the bind and report it (the `EJECTED_IN_UMBREL`
  status warning) rather than silently falling back to a classic mount, since that could fight a deliberate
  eject; if umbreld was simply restarting, its mount reappears and the app re-binds automatically.

Alongside the ladder, the app also **reaps** stale entries under `<UMBREL_ROOT>/external/` that match this
drive's mount label (or umbrelOS's `<label> (2)`, `<label> (3)`, ... collision names): empty leftover
directories with nothing mounted on them, and dead mounts left behind by a device that's since gone away
(a stale mount from before a USB reconnect, for example). This is what keeps umbrelOS able to reuse the
clean, un-suffixed name on remount instead of drifting further with every reconnect. Reaping never touches
non-empty directories, other drives' folders, or any live mount it doesn't recognize as its own.

Since v0.2.1, a leftover directory that isn't literally empty but whose entire subtree is nothing but empty
directories (a leftover empty mount-point skeleton, typically) is also safely reclaimable: the app walks the
whole subtree first and only proceeds if every node in it is a directory - if it finds so much as one file or
symlink anywhere in the tree, it leaves the whole leftover untouched and flags it on the dashboard
(`LEFTOVER_HAS_FILES`) for manual review instead. When it does proceed, removal is bottom-up `rmdir` only -
never a recursive delete - which cannot remove anything but an empty directory, so even a bug in the
empty-subtree check couldn't lose data. This is what's usually behind umbrelOS drifting the drive's name to
`<label> (2)` even though nothing looks obviously wrong: a stale, all-empty leftover directory blocking the
clean name. A **"Reclaim clean name"** button appears on the dashboard when the app detects this drift and
the leftover is safely reclaimable; it clears the leftover and re-hands the drive to umbrelOS so it remounts
under the clean, un-suffixed name, restarting Plex once in the process (same auto-revert-to-classic-on-failure
guarantee as the mode switch above). If the leftover contains real files, the button is replaced by the
`LEFTOVER_HAS_FILES` note instead, and nothing is deleted automatically.

### Switching modes

Classic mode remains the default after upgrading to v0.2.0 - nothing changes until you explicitly switch.
To turn cooperative mode on, use the **"Switch to cooperative mode"** action on the dashboard. It's a
danger-lite, confirm-first action (the confirmation dialog spells out that Plex will restart once) that runs
as a single logged job, the same way "Run Full Restore" does:

1. Saves the `cooperative` mode setting.
2. Reaps stale leftovers under umbrelOS's external-storage folder.
3. Unmounts the app's own direct mount of the drive at `<mountPoint>`.
4. Tries to force umbrelOS to notice the drive: since umbrelOS's auto-mounter only scans when it sees a
   device-connect event (there's no periodic rescan), the app synthesizes one by toggling the drive's USB
   port authorization off and back on at the kernel level (`sysfs`) - safe to do at this point because the
   drive was just unmounted in the previous step.
5. Waits (up to the grace period) for umbrelOS's own mount to appear.
6. Binds `<mountPoint>` to it.
7. Restarts Plex once, so it picks up the newly-bound path (Docker only resolves a bind's source when a
   container starts).
8. Verifies everything is healthy and that umbrelOS can now see the mount, and reports the result.

**If the automatic USB replug (step 4) doesn't work** - some environments don't expose the USB
authorization toggle - the dashboard tells you to physically unplug and reconnect the drive's USB cable
yourself; once umbrelOS notices it and mounts it, the monitor completes the switch (the bind step)
automatically on its own next check, with no further action needed.

**If any step of the switch fails**, the app automatically reverts to a classic direct mount by UUID so
Plex is never left without its media, reports exactly why on the dashboard, and leaves the mode setting on
`cooperative` so it will keep trying to bind on the next safe opportunity rather than silently staying on
the fallback forever.

**"Switch to classic mode"** reverses the process: unmounts the bind, mounts the drive directly by UUID,
and reminds you that the Files "Format Required" prompt will come back (see above - it's safe to ignore).

### Cooperative mode is opt-in and comes with a caveat

`mountMode` defaults to `classic` on both fresh installs and upgrades from v0.1.x - the mount behavior of an
existing installation never changes on its own. Cooperative mode depends on umbrelOS's own auto-mounter
behavior (undocumented, version-specific internals of `getumbrel/umbrel`, not a public API this app
controls), so if a future umbrelOS release changes how or where it auto-mounts drives, cooperative mode may
need an app update to keep working; classic mode has no such dependency and will keep working regardless.

## Privileged access

This app requests the broadest host-access grant of any app in this store, and you should understand what
it's for before installing it. In `docker-compose.yml`, the daemon container runs:

- **`privileged: true`** and **`pid: "host"`** - together these make PID 1 in the container's own process
  namespace be the host's *real* init process, which is what lets `nsenter -t 1 -m -u -i -n -- <cmd>` (used
  for every host mount, host file write, and host command the daemon runs) actually re-enter the host's
  mount/UTS/IPC/network namespaces instead of the container's own.
- **`/var/run/docker.sock:/var/run/docker.sock`** - a bind-mount of the host's real Docker socket, needed to
  inspect the running Plex container's state/bindings and to recreate it after patching its compose file.

Of the 14 official Umbrel apps that use `privileged: true`, none use `pid: "host"` or bind-mount the real
host Docker socket (the ones that touch Docker at all do so through a `docker:dind` sidecar, which is a
contained, disposable Docker daemon - not the host's own). Granting an app this level of host control is
explicitly against official Umbrel App Store submission policy. **This is why this app is, and will only
ever be, distributed through this personal community app store** - never submitted to Umbrel's official
store. Install it only if you're comfortable with a container that can read/write host files and control
the host's Docker daemon; every host-file mutation is backed up first, to `/data/backups` inside the
container - which is `${UMBREL_ROOT}/app-data/hmlebtc-drive-remount-for-plex/data/backups` on the host,
since `/data` is just this app's bind-mounted persistent storage - keeping the newest 20 backups per file,
and every mutation is logged to the activity feed. `/etc/fstab` is never touched, and no other host files
outside the boot hook and Plex's own compose file are ever written.

## Install on Umbrel

1. On your Umbrel, go to **Settings → App Store → Add a community app store**.
2. Enter this repo's URL: `https://github.com/hmlebtc/umbrel-drive-remount-for-plex`.
3. Open the new "Drive Remount for Plex App Store" and install **Drive Remount for Plex**.

> **Note for anyone running their own fork/build:** GHCR packages default to **private**. If you publish
> your own image via the [release process](#release-process) below, go to the package's settings on
> GitHub (`https://github.com/users/<you>/packages/container/umbrel-drive-remount-for-plex/settings`) and
> set visibility to **Public** - Umbrel pulls the image anonymously, with no registry login, so a private
> package will fail to pull with a generic "manifest unknown" / permission error.

## First-run setup

The app boots with the default settings baked into `docker-compose.yml` (`DRP_*` env vars), which only seed
`/data/settings.json` the first time it's created - after that, whatever's saved in the dashboard wins, and
an app update or container recreation never clobbers a live edit.

1. Open the dashboard and check the Settings card: confirm (or correct) the drive's filesystem UUID,
   filesystem type, desired mount point, media subdirectory, folder names, and the Plex app id.
2. Hit **Run Full Restore** on the Actions card. This installs the boot hook, mounts the drive, patches
   Plex's compose file, and recreates Plex only if it isn't already bound - safe to run on a healthy system,
   where it's a no-op that just reports "already healthy".
3. Watch the job log for each step's result. Once it finishes, the six status tiles (Drive, Mount, Boot
   hook, Compose patch, Plex bind, Media folders) should all read healthy, and your media folders should be
   visible inside Plex.
4. Leave **Auto-heal** on (the default) so future drift - a reconnect, a Plex app update, an OS update - is
   repaired automatically; the Actions card shows a suspended banner with a reset button if it ever gives up
   after repeated failures.

## Configuration reference

Everything below is editable live from the dashboard's **Settings** card (`PUT /api/settings`); the `DRP_*`
env vars in `docker-compose.yml` only *seed* `settings.json` the first time the app boots (when no
`settings.json` exists yet).

| Setting (UI) | settings.json path | Env var (first-boot seed) | Default |
|---|---|---|---|
| Drive UUID | `uuid` | `DRP_UUID` | `555bf6f0-ae17-4137-adec-e91818854f1c` |
| Filesystem type | `fsType` | `DRP_FSTYPE` | `ext4` |
| Mount point | `mountPoint` | `DRP_MOUNT_POINT` | `/mnt/wdexternal` |
| Mount mode | `mountMode` | `DRP_MOUNT_MODE` | `classic` (`classic` or `cooperative`) |
| Grace period before falling back to classic (s) | `graceSec` | `DRP_GRACE_SECONDS` | `180` (clamped 60-900) |
| Media subdirectory | `mediaSubdir` | `DRP_MEDIA_SUBDIR` | `media` |
| Folders | `folders` | `DRP_FOLDERS` (comma-separated) | `Movies,TVshows,Music` |
| Plex app id | `plexAppId` | `DRP_PLEX_APP_ID` | `plex` |
| Umbrel root | `umbrelRoot` | `DRP_UMBREL_ROOT` | `/home/umbrel/umbrel` |
| Container media path | `containerMediaPath` | `DRP_CONTAINER_MEDIA_PATH` | `/media/wdexternal` |
| Auto-heal enabled | `autoHeal.enabled` | `DRP_AUTOHEAL_ENABLED` | `true` |
| Auto-heal check interval (s) | `autoHeal.intervalSec` | `DRP_AUTOHEAL_INTERVAL_SECONDS` | `30` (clamped 10-3600) |
| Auto-heal cooldown (s) | `autoHeal.cooldownSec` | `DRP_AUTOHEAL_COOLDOWN_SECONDS` | `300` (clamped 60-86400) |
| Max consecutive failures before suspend | `autoHeal.maxConsecutiveFailures` | `DRP_AUTOHEAL_MAX_CONSECUTIVE_FAILURES` | `3` |
| Consecutive broken checks required (debounce) | `autoHeal.requireConsecutiveBroken` | `DRP_AUTOHEAL_REQUIRE_CONSECUTIVE_BROKEN` | `2` |

`DRP_HTTP_PORT` (default `3012`) and `DRP_DATA_DIR` (default `/data`) are process-level env vars, read at
startup only - they're not part of `settings.json` and aren't editable from the dashboard.

Two paths are derived from settings rather than stored directly: the Plex compose file the app patches is
`<umbrelRoot>/app-data/<plexAppId>/docker-compose.yml`, and the boot hook it manages is
`<umbrelRoot>/custom-hooks/pre-start`.

## Legacy artifacts from an older manual setup

If you previously solved this problem by hand (an `/etc/fstab` line, a udev rule, a systemd unit,
`/usr/local/bin` scripts, or a `docker-compose.override.yml` on Plex), you don't need to remove any of it
before installing this app:

- The OS-slot artifacts - `/etc/fstab`, udev rules, systemd units, anything under `/usr/local/bin` - are
  wiped automatically the next time umbrelOS updates (that's the whole reason they're unreliable in the
  first place). Until then they're harmless alongside this app; the app never edits or deletes them. If a
  legacy `/etc/fstab` entry for the same drive UUID is still present, the dashboard's Compose patch tile
  reports it informationally (`legacyFstabEntryPresent`) - it is never modified.
- A legacy `docker-compose.override.yml` next to Plex's compose file is likewise harmless now (umbreld never
  reads it - see [The problem](#the-problem) above) and is reported informationally
  (`legacyOverridePresent`) rather than deleted, in case you want to keep it around for a non-Umbrel use of
  the same compose directory. When one is detected, the dashboard's Actions card shows a **Remove legacy
  override** button so you don't have to SSH in to clean it up: it backs the file up to
  `<UMBREL_ROOT>/app-data/hmlebtc-drive-remount-for-plex/data/backups`, then deletes it, and clears the
  status note once it's gone.

## Development

Requires Node 22+.

```bash
npm install
npm run build     # tsc -> dist/
npm test          # build, then node --test against dist/
npm run dev        # build, then run node dist/main.js
```

Local run, no Docker, against an in-memory mock of the host (mounts table, files, Docker state) instead of
the real `nsenter`/`/proc/1/root`/Docker-socket adapter:

```bash
MOCK=1 DRP_HTTP_PORT=3012 node dist/main.js
```

With `MOCK=1`, `POST /api/mock/scenario` is enabled (404 otherwise) to switch the mock host between
scenarios - drive absent, stale mount, missing boot hook, missing compose patch, Plex container missing the
bind, and so on - so the whole restore/monitor/dashboard flow can be exercised without a real umbrelOS box
or a real Plex container. `MOCK=1` must never be set in `docker-compose.yml`.

Then open `http://localhost:3012`. Runtime npm dependencies are intentionally zero - the app is built on
`node:http`, `node:test`, and the global `fetch`; `typescript` and `@types/node` are dev-only.

## Release process

1. Bump the version in three places, kept in lockstep: `package.json` (`version`),
   `hmlebtc-drive-remount-for-plex/umbrel-app.yml` (`version`), and the image tag pinned in
   `hmlebtc-drive-remount-for-plex/docker-compose.yml`.
2. Add a `releaseNotes` entry to `umbrel-app.yml` for the new version.
3. Commit, then tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. `.github/workflows/docker-publish.yml` builds `linux/amd64` + `linux/arm64`, runs `npm test`, and pushes
   `ghcr.io/hmlebtc/umbrel-drive-remount-for-plex` tagged `X.Y.Z`, `X.Y`, `X`, the `v`-prefixed mirrors of
   each, and `latest`. A manual `workflow_dispatch` with a `version` input works too, for when pushing a tag
   isn't an option.
5. **First publish only:** GHCR packages default to **private**. Immediately after the workflow's first
   successful push, go to
   `https://github.com/users/hmlebtc/packages/container/umbrel-drive-remount-for-plex/settings` and flip
   visibility to **Public** - Umbrel pulls images anonymously with no registry credentials, so a private
   package fails every install with a generic "manifest unknown" error. This is a one-time step per
   package; subsequent version pushes to the same package name stay public.

## License

[MIT](LICENSE)
