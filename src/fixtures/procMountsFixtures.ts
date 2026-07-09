// Fixtures for mounts.test.ts (spec section 4: "Host mount table: /proc/1/mounts
// (parse octal escapes, e.g. \040)").
//
// Notes on the raw text below:
//  - Each embedded "\\040" is a literal backslash followed by "040" in the
//    resulting string (i.e. what actually appears in /proc/mounts for an
//    encoded space), NOT an escaped octal character in this TS source.
//  - /mnt/wdexternal appears twice (duplicate target): first a stale/ro
//    mount, then (further down, i.e. later/most-recent) the active rw one.
//    findMount() must return the LAST entry for a given target.

export const PROC_MOUNTS_SAMPLE =
  [
    "sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0",
    "proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0",
    "/dev/sda1 / ext4 rw,relatime,errors=remount-ro 0 0",
    "tmpfs /run tmpfs rw,nosuid,nodev,size=804928k,mode=755 0 0",
    "/dev/sdd1 /mnt/readonlydrive ext4 ro,relatime 0 0",
    "/dev/sdb1 /mnt/wdexternal ext4 ro,relatime 0 0",
    "/dev/sdb1 /mnt/wdexternal ext4 rw,relatime 0 0",
    "/dev/sdc1 /media/My\\040External\\040Drive vfat rw,relatime,uid=1000,gid=1000,fmask=0022,dmask=0022 0 0",
    "overlay /var/lib/docker/overlay2/abc123def/merged overlay rw,relatime,lowerdir=/a:/b,upperdir=/c,workdir=/d 0 0",
  ].join("\n") + "\n";

export const PROC_MOUNTS_ENTRY_COUNT = 9;
