// Tests for bootHook.ts (spec section 6(a), section 10 frozen signature):
//
//   export function ensureHookBlock(
//     existing: string | null,
//     opts: { uuid: string; mountPoint: string; fsType: string },
//   ): { text: string; changed: boolean; foreignContentPreserved: boolean }
//
// bootHook.ts is owned by B1 and does not exist at the time this file was
// written (B1 builds in parallel) — this test is written strictly against
// the frozen signature above and the behavior described in spec section 6(a).
// File-system side effects (chmod 755, ensuring the parent dir exists,
// backups) are NOT part of this pure function per the frozen signature and
// are therefore not tested here.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureHookBlock } from "./bootHook.js";
import {
  EXPECTED_HOOK_BLOCK_DEFAULT,
  FOREIGN_SCRIPT_NO_SHEBANG,
  FOREIGN_SCRIPT_WITH_SHEBANG,
  HOOK_FSTYPE,
  HOOK_MOUNT_POINT,
  HOOK_UUID,
  HOOK_WITH_MARKERS_STALE,
} from "./fixtures/bootHookFixtures.js";

const BEGIN_MARKER = "# BEGIN drive-remount-for-plex (managed block - do not edit inside)";
const END_MARKER = "# END drive-remount-for-plex";

// ---------------------------------------------------------------------------
// create-from-null
// ---------------------------------------------------------------------------

test("create-from-null: shebang + block, matches the spec example verbatim", () => {
  const result = ensureHookBlock(null, {
    uuid: HOOK_UUID,
    mountPoint: HOOK_MOUNT_POINT,
    fsType: HOOK_FSTYPE,
  });
  assert.equal(result.changed, true);
  assert.equal(result.foreignContentPreserved, false);
  assert.equal(result.text.trim(), EXPECTED_HOOK_BLOCK_DEFAULT.trim());
  assert.ok(result.text.startsWith("#!/bin/sh"));
  assert.ok(result.text.includes(BEGIN_MARKER));
  assert.ok(result.text.includes(END_MARKER));
});

test("create-from-null: the mount command always ends with `|| true`", () => {
  const result = ensureHookBlock(null, {
    uuid: HOOK_UUID,
    mountPoint: HOOK_MOUNT_POINT,
    fsType: HOOK_FSTYPE,
  });
  const mountLine = result.text.split("\n").find((l) => l.includes("mount -t"));
  assert.ok(mountLine, "expected a mount -t line in the block");
  assert.ok(mountLine!.trim().endsWith("|| true"), "mount command must never fail the hook");
});

test("create-from-null: uuid/mountPoint/fsType are templated correctly (non-default values)", () => {
  const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const mountPoint = "/mnt/data2";
  const fsType = "xfs";
  const result = ensureHookBlock(null, { uuid, mountPoint, fsType });

  assert.equal(result.changed, true);
  assert.ok(result.text.includes(`mkdir -p '${mountPoint}'`));
  assert.ok(result.text.includes(`mountpoint -q '${mountPoint}'`));
  assert.ok(
    result.text.includes(`mount -t '${fsType}' '/dev/disk/by-uuid/${uuid}' '${mountPoint}' || true`),
  );
  // The stale defaults must NOT leak through.
  assert.ok(!result.text.includes(HOOK_MOUNT_POINT));
  assert.ok(!result.text.includes(HOOK_UUID));
  assert.ok(!result.text.includes("ext4"));
});

// ---------------------------------------------------------------------------
// Canonical block: single-quoted values + bounded USB-settle wait loop.
// ---------------------------------------------------------------------------

test("create-from-null: waits (bounded) for the by-uuid device before mounting", () => {
  const result = ensureHookBlock(null, {
    uuid: HOOK_UUID,
    mountPoint: HOOK_MOUNT_POINT,
    fsType: HOOK_FSTYPE,
  });
  // A bounded wait loop guards against the USB device not being udev-settled
  // yet when the pre-start hook runs (right after local-fs.target).
  assert.ok(result.text.includes("i=0"), "expected the wait-loop counter to be initialised");
  assert.ok(
    result.text.includes(
      `while [ ! -e '/dev/disk/by-uuid/${HOOK_UUID}' ] && [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done`,
    ),
    "expected a bounded (30s) wait for the by-uuid symlink before mounting",
  );
  // Values are single-quoted (defense in depth); the wait precedes the mkdir/mount.
  const waitIdx = result.text.indexOf("while [ ! -e");
  const mkdirIdx = result.text.indexOf("mkdir -p '");
  const mountIdx = result.text.indexOf("mount -t '");
  assert.ok(waitIdx >= 0 && mkdirIdx > waitIdx && mountIdx > mkdirIdx, "wait loop must come before mkdir/mount");
});

// ---------------------------------------------------------------------------
// Foreign existing script WITHOUT markers.
// ---------------------------------------------------------------------------

test("foreign script without markers (has shebang): preserved verbatim, block appended", () => {
  const result = ensureHookBlock(FOREIGN_SCRIPT_WITH_SHEBANG, {
    uuid: HOOK_UUID,
    mountPoint: HOOK_MOUNT_POINT,
    fsType: HOOK_FSTYPE,
  });
  assert.equal(result.changed, true);
  assert.equal(result.foreignContentPreserved, true);

  assert.ok(result.text.includes('echo "custom hook from another app"'));
  assert.ok(result.text.includes("some-other-command --flag"));
  assert.ok(result.text.includes(BEGIN_MARKER));
  assert.ok(result.text.includes(END_MARKER));

  // Foreign content comes before our appended block; nothing destroyed.
  const foreignIdx = result.text.indexOf("some-other-command --flag");
  const beginIdx = result.text.indexOf(BEGIN_MARKER);
  assert.ok(foreignIdx >= 0 && beginIdx >= 0 && foreignIdx < beginIdx);
});

test("foreign script without markers (no shebang): left as-is, no shebang injected", () => {
  const result = ensureHookBlock(FOREIGN_SCRIPT_NO_SHEBANG, {
    uuid: HOOK_UUID,
    mountPoint: HOOK_MOUNT_POINT,
    fsType: HOOK_FSTYPE,
  });
  assert.equal(result.changed, true);
  assert.equal(result.foreignContentPreserved, true);
  assert.ok(result.text.startsWith('echo "no shebang here"'), "must not force-inject a shebang");
  assert.ok(result.text.includes("touch /tmp/marker"));
  assert.ok(result.text.includes(BEGIN_MARKER));
  assert.ok(result.text.includes(END_MARKER));
});

// ---------------------------------------------------------------------------
// Existing WITH markers: idempotent replace, foreign lines outside untouched.
// ---------------------------------------------------------------------------

test("existing with markers: block content is replaced, foreign lines outside untouched", () => {
  const result = ensureHookBlock(HOOK_WITH_MARKERS_STALE, {
    uuid: HOOK_UUID,
    mountPoint: HOOK_MOUNT_POINT,
    fsType: HOOK_FSTYPE,
  });
  assert.equal(result.changed, true);
  assert.equal(result.foreignContentPreserved, true);

  // Foreign lines outside the markers survive untouched, in place.
  assert.ok(result.text.includes('echo "before our block"'));
  assert.ok(result.text.includes('echo "after our block"'));
  const beforeIdx = result.text.indexOf('echo "before our block"');
  const beginIdx = result.text.indexOf(BEGIN_MARKER);
  const endIdx = result.text.indexOf(END_MARKER);
  const afterIdx = result.text.indexOf('echo "after our block"');
  assert.ok(beforeIdx < beginIdx && beginIdx < endIdx && endIdx < afterIdx);

  // Stale block content is gone, replaced with the correct values.
  assert.ok(!result.text.includes("/mnt/OLDPATH"));
  assert.ok(!result.text.includes("00000000-0000-0000-0000-000000000000"));
  assert.ok(!result.text.includes("vfat"));
  assert.ok(result.text.includes(`mkdir -p '${HOOK_MOUNT_POINT}'`));
  assert.ok(
    result.text.includes(
      `mount -t '${HOOK_FSTYPE}' '/dev/disk/by-uuid/${HOOK_UUID}' '${HOOK_MOUNT_POINT}' || true`,
    ),
  );
});

test("existing with markers: re-applying the SAME opts is idempotent (changed:false)", () => {
  const first = ensureHookBlock(HOOK_WITH_MARKERS_STALE, {
    uuid: HOOK_UUID,
    mountPoint: HOOK_MOUNT_POINT,
    fsType: HOOK_FSTYPE,
  });
  assert.equal(first.changed, true);

  const second = ensureHookBlock(first.text, {
    uuid: HOOK_UUID,
    mountPoint: HOOK_MOUNT_POINT,
    fsType: HOOK_FSTYPE,
  });
  assert.equal(second.changed, false);
  assert.equal(second.foreignContentPreserved, true);
  assert.equal(second.text, first.text);

  // Foreign lines are still untouched after the idempotent no-op pass.
  assert.ok(second.text.includes('echo "before our block"'));
  assert.ok(second.text.includes('echo "after our block"'));
});
