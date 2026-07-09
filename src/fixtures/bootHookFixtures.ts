// Fixtures for bootHook.test.ts (spec section 6(a)).

export const HOOK_UUID = "555bf6f0-ae17-4137-adec-e91818854f1c";
export const HOOK_MOUNT_POINT = "/mnt/wdexternal";
export const HOOK_FSTYPE = "ext4";

// The exact expected output when creating the hook from scratch with the spec's
// example settings. Canonical managed block: values single-quoted (defense in
// depth) and a bounded USB-settle wait loop before the mount.
export const EXPECTED_HOOK_BLOCK_DEFAULT =
  "#!/bin/sh\n" +
  "# BEGIN drive-remount-for-plex (managed block - do not edit inside)\n" +
  "i=0\n" +
  "while [ ! -e '/dev/disk/by-uuid/555bf6f0-ae17-4137-adec-e91818854f1c' ] && [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done\n" +
  "mkdir -p '/mnt/wdexternal'\n" +
  "if ! mountpoint -q '/mnt/wdexternal'; then\n" +
  "  mount -t 'ext4' '/dev/disk/by-uuid/555bf6f0-ae17-4137-adec-e91818854f1c' '/mnt/wdexternal' || true\n" +
  "fi\n" +
  "# END drive-remount-for-plex";

// A foreign pre-start script with a shebang, no markers.
export const FOREIGN_SCRIPT_WITH_SHEBANG =
  '#!/bin/sh\necho "custom hook from another app"\nsome-other-command --flag\n';

// A foreign pre-start script with NO shebang at all.
export const FOREIGN_SCRIPT_NO_SHEBANG = 'echo "no shebang here"\ntouch /tmp/marker\n';

// An existing hook that already has our managed block (STALE values, to
// exercise idempotent replacement), with foreign content both before and
// after the managed block.
export const HOOK_WITH_MARKERS_STALE =
  "#!/bin/sh\n" +
  'echo "before our block"\n' +
  "# BEGIN drive-remount-for-plex (managed block - do not edit inside)\n" +
  "mkdir -p /mnt/OLDPATH\n" +
  "if ! mountpoint -q /mnt/OLDPATH; then\n" +
  "  mount -t vfat /dev/disk/by-uuid/00000000-0000-0000-0000-000000000000 /mnt/OLDPATH || true\n" +
  "fi\n" +
  "# END drive-remount-for-plex\n" +
  'echo "after our block"\n';
