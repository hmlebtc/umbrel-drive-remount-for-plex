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

1. **Boot hook** (`<UMBREL_ROOT>/custom-hooks/pre-start`) - umbrelOS runs this script on every boot, after
   `local-fs.target`/`network-online.target` and before `umbreld` itself starts (via the
   `umbrel-custom-pre-start.service` unit, 5-minute timeout, must be executable). Because it lives on the
   persistent partition, it survives OS updates the way `/etc/fstab` never could. The app manages a single
   marked block inside this file (`# BEGIN drive-remount-for-plex` / `# END`) that mounts the drive by
   filesystem UUID - foreign content in the file is always preserved, never overwritten. The hook waits up
   to ~30 seconds for the drive to enumerate under `/dev/disk/by-uuid` (USB udev settle), then makes one
   best-effort mount attempt (`mount ... || true`); it never blocks or fails boot, and if the drive still
   isn't up by then, the app's own monitor (below) picks up the still-unmounted drive on one of its first
   checks after the container starts and mounts it then.
2. **Compose patch** (`<UMBREL_ROOT>/app-data/<plexAppId>/docker-compose.yml`) - the app inserts one volume
   line into Plex's *installed* compose file, not the pristine store copy. This works, where an override
   wouldn't, because umbreld's `patchComposeFile()` re-serializes and force-injects `container_name` into
   this exact file on every install/update/start, and its YAML round-trip preserves extra volume entries -
   so umbreld's own restart of Plex keeps the bind. Only a Plex *app update* re-copies the pristine file and
   drops the patch; the monitor (below) detects that and re-heals it.
3. **The mount itself** - `mount -t <fsType> /dev/disk/by-uuid/<uuid> <mountPoint>`, run at runtime through
   `nsenter` for on-demand healing (the boot hook covers the reboot case). The app never touches
   `/etc/fstab`; if it finds a legacy fstab entry for the same drive, it reports it informationally and
   leaves it alone.
4. **Monitor + auto-heal** - a background loop (default every 30s) checks all of the above plus the running
   Plex container's actual bind (via the Docker Engine API) and the media folders' presence, and can
   trigger a full restore automatically when something's broken, debounced against transient states and
   rate-limited by a cooldown. It only recreates the Plex container when the container is actually missing
   the bind - a drifted hook or compose patch on an otherwise healthy, already-bound Plex is repaired
   silently, with zero Plex downtime.
5. **Dashboard** - status tiles for each of the six checks above, one-click "Run Full Restore" and "Restart
   Plex", a live job log, activity history, and a settings form - all behind Umbrel's own session login via
   `app_proxy`.

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
