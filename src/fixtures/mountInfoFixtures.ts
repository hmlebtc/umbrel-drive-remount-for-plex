// Fixtures for backing.test.ts (spec section 2: parse /proc/1/mountinfo, NOT
// just /proc/1/mounts — fields: mountId parentId major:minor root mountpoint
// options <optional-fields> " - " fstype source superOptions).
//
// Notes on the raw text below:
//  - Each embedded "\\040" is a literal backslash followed by "040" in the
//    resulting string (what actually appears in mountinfo for an encoded
//    space), NOT an escaped octal character in this TS source.
//  - The sample deliberately mixes the number of OPTIONAL fields (field 7):
//    zero ("/proc"), one ("shared:1"), and several ("shared:1 master:2") — a
//    correct parser must find the " - " separator, not assume a fixed column.
//  - Octal escapes appear in BOTH the root field (entry 120) and the mountpoint
//    field (entry 110), because the kernel escapes either.

/** major:minor is field 3; MountInfoEntry deliberately DROPS it. */
export const PROC_MOUNTINFO_SAMPLE =
  [
    // one optional field
    '21 24 0:20 / /sys rw,nosuid,nodev,noexec,relatime shared:2 - sysfs sysfs rw',
    // ZERO optional fields (straight to the "-" separator)
    '22 24 0:4 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw',
    // the root filesystem
    '24 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw,errors=remount-ro',
    // umbrelOS /External mount of our drive (root "/", real fs-root mount)
    '101 24 8:1 / /home/umbrel/umbrel/external/wdexternal rw,relatime shared:1 master:2 - ext4 /dev/sda1 rw',
    // our stable-path bind of that mount (same source device, root "/")
    '102 24 8:1 / /mnt/wdexternal rw,relatime - ext4 /dev/sda1 rw',
    // octal-escaped SPACES in the mountpoint field
    '110 24 8:1 / /media/My\\040External\\040Drive rw,relatime shared:5 - ext4 /dev/sdc1 rw',
    // octal-escaped space in the ROOT field (a sub-tree bind)
    '120 24 8:1 /Movies\\040HD /srv/pub rw,relatime - ext4 /dev/sda1 rw',
    // an overlay with lots of super-options (must survive multi-value superOpts)
    '150 24 0:60 / /var/lib/docker/overlay2/abc/merged rw,relatime - overlay overlay rw,lowerdir=/a:/b,upperdir=/c,workdir=/d',
  ].join('\n') + '\n';

export const PROC_MOUNTINFO_ENTRY_COUNT = 8;

// ---------------------------------------------------------------------------
// Small, targeted mountinfo strings for classifyBacking cases. Each is fed
// through parseMountInfo() so the classifier is exercised on decoded entries.
// externalBase is /home/umbrel/umbrel/external, mountPoint is /mnt/wdexternal,
// the live drive device is /dev/sda1 (renumbered to /dev/sdb1 in the replug case).
// ---------------------------------------------------------------------------

/** umbrelOS mounted our drive AND we hold a bind of it — the coop-healthy shape. */
export const MI_COOP_HEALTHY =
  [
    '24 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw',
    '101 24 8:1 / /home/umbrel/umbrel/external/wdexternal rw,relatime shared:1 - ext4 /dev/sda1 rw',
    '102 24 8:1 / /mnt/wdexternal rw,relatime - ext4 /dev/sda1 rw',
  ].join('\n') + '\n';

/** A leftover dir drifted umbreld to "wdexternal (2)"; no stable-path mount yet. */
export const MI_PATH_DRIFT =
  [
    '24 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw',
    '101 24 8:1 / /home/umbrel/umbrel/external/wdexternal\\040(2) rw,relatime - ext4 /dev/sda1 rw',
  ].join('\n') + '\n';

/**
 * Two umbrelOS mounts of the same drive (an older + a fresh one); newest mountId
 * must win per spec section 2. No stable-path mount.
 */
export const MI_TWO_UMBREL_MOUNTS =
  [
    '24 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw',
    '90 24 8:1 / /home/umbrel/umbrel/external/wdexternal rw,relatime - ext4 /dev/sda1 rw',
    '205 24 8:1 / /home/umbrel/umbrel/external/wdexternal\\040(2) rw,relatime - ext4 /dev/sda1 rw',
  ].join('\n') + '\n';

/** We hold a classic DIRECT mount; umbreld is skipped (no /External mount). */
export const MI_DIRECT_ONLY =
  [
    '24 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw',
    '102 24 8:1 / /mnt/wdexternal rw,relatime - ext4 /dev/sda1 rw',
  ].join('\n') + '\n';

/**
 * Device renumbered sda1 -> sdb1: the old umbrel mount + our old bind still
 * reference the now-gone /dev/sda1 (DEAD), while umbreld re-mounted the live
 * /dev/sdb1 (drifted to "(2)").
 */
export const MI_STALE_AFTER_REPLUG =
  [
    '24 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw',
    '101 24 8:1 / /home/umbrel/umbrel/external/wdexternal rw,relatime - ext4 /dev/sda1 rw',
    '102 24 8:1 / /mnt/wdexternal rw,relatime - ext4 /dev/sda1 rw',
    '301 24 8:17 / /home/umbrel/umbrel/external/wdexternal\\040(2) rw,relatime - ext4 /dev/sdb1 rw',
  ].join('\n') + '\n';

/** Drive present, but umbreld's /External mount is gone (user pressed Eject). */
export const MI_EJECTED =
  [
    '24 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw',
    '102 24 8:1 / /mnt/wdexternal rw,relatime - ext4 /dev/sda1 rw',
  ].join('\n') + '\n';

/** No mounts of our drive at all (just booted; umbreld has not scanned). */
export const MI_NOTHING =
  ['24 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw'].join('\n') + '\n';
