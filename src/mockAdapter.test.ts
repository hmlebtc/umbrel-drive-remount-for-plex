// Tests for mockAdapter.ts (spec sections 0, 9, 10) — the umbreld coexistence
// SIMULATION itself. These are entirely self-contained (mock + parseMountInfo)
// so they validate the simulation mechanics independently of B1's engine code:
//   (a) the lsblk skip rule, (b) getUniqueName "(N)" drift, (c) replug re-scan,
//   (d) eject, plus readProcMountInfo synthesis, removeDir semantics, and the
//   docker-exec in-container liveness view.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMockAdapter } from './mockAdapter.js';
import { parseMountInfo } from './backing.js';
import { byUuidPath } from './paths.js';
import { defaultSettings } from './settings.js';

const S = defaultSettings();
const EXTERNAL_BASE = `${S.umbrelRoot}/external`;
const PLEX = 'plex_server_1';

// ---------------------------------------------------------------------------
// Legacy behaviour is byte-for-byte preserved (backward-compat is sacred).
// ---------------------------------------------------------------------------

test('mock legacy: /proc/1/mounts for "healthy" is byte-identical to v0.1.2', async () => {
  const a = createMockAdapter('healthy');
  const expected =
    [
      'sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0',
      'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
      '/dev/sda2 / ext4 rw,relatime 0 0',
      '/dev/sdb1 /mnt/wdexternal ext4 rw,relatime 0 0',
    ].join('\n') + '\n';
  assert.equal(await a.readProcMounts(), expected);
});

// ---------------------------------------------------------------------------
// (a) lsblk skip rule: umbreld never mounts a raw device we already hold.
// ---------------------------------------------------------------------------

test('mock: umbreld SKIPS mounting while our app holds a mount of the raw device (§0 lsblk skip)', async () => {
  const a = createMockAdapter('umbrelMountsLate');
  assert.equal(a.umbrelMountPath(), null, 'no /External mount at boot');

  // Our app takes a direct mount of the device first.
  await a.exec(['mount', '-t', 'ext4', byUuidPath(S), S.mountPoint]);
  a.simulateUmbreldMount();
  assert.equal(a.umbrelMountPath(), null, 'umbreld must skip a device already mounted');

  // Release it; now umbreld can mount.
  await a.exec(['umount', '-l', S.mountPoint]);
  a.simulateUmbreldMount();
  assert.equal(a.umbrelMountPath(), `${EXTERNAL_BASE}/wdexternal`);
});

// ---------------------------------------------------------------------------
// (b) getUniqueName drift when a leftover dir occupies the clean name.
// ---------------------------------------------------------------------------

test('mock: a leftover dir drifts umbreld to "wdexternal (2)" (§0 getUniqueName)', async () => {
  const a = createMockAdapter('umbrelMountsLate');
  a.simulateUmbreldMount();
  assert.equal(a.umbrelMountPath(), `${EXTERNAL_BASE}/wdexternal`);

  // Eject leaves the (now empty) directory behind; a fresh scan drifts.
  a.simulateEject();
  assert.equal(a.umbrelMountPath(), null);
  a.simulateUmbreldMount();
  assert.equal(a.umbrelMountPath(), `${EXTERNAL_BASE}/wdexternal (2)`);
});

test('mock: the umbrelPathDrift scenario ships already drifted to "(2)"', () => {
  const a = createMockAdapter('umbrelPathDrift');
  assert.equal(a.umbrelMountPath(), `${EXTERNAL_BASE}/wdexternal (2)`);
});

// ---------------------------------------------------------------------------
// (c) replug re-enumeration + re-scan.
// ---------------------------------------------------------------------------

test('mock: replug with renumber makes old mounts dead and re-scans onto the new device', async () => {
  const a = createMockAdapter('coopHealthy');
  assert.equal(await a.realpath(byUuidPath(S)), '/dev/sda1');
  a.simulateReplug({ renumber: true });
  assert.equal(await a.realpath(byUuidPath(S)), '/dev/sdb1', 'device renumbered');

  const entries = parseMountInfo(await a.readProcMountInfo());
  const live = entries.find((e) => e.mountpoint.startsWith(`${EXTERNAL_BASE}/`) && e.source === '/dev/sdb1');
  assert.ok(live, 'umbreld re-mounted the drive on its new /dev node');
});

// ---------------------------------------------------------------------------
// readProcMountInfo synthesis round-trips through parseMountInfo.
// ---------------------------------------------------------------------------

test('mock: readProcMountInfo synthesizes valid, parseable mountinfo with roots + sources', async () => {
  const a = createMockAdapter('coopHealthy');
  const entries = parseMountInfo(await a.readProcMountInfo());

  const umbrel = entries.find((e) => e.mountpoint === `${EXTERNAL_BASE}/wdexternal`);
  assert.ok(umbrel, 'the /External mount is present');
  assert.equal(umbrel!.root, '/');
  assert.equal(umbrel!.source, '/dev/sda1');
  assert.equal(umbrel!.fsType, 'ext4');

  const bind = entries.find((e) => e.mountpoint === S.mountPoint);
  assert.ok(bind, 'our stable-path bind is present');
  assert.equal(bind!.source, '/dev/sda1');

  // Every entry carries a numeric mountId + parentId (kernel invariant).
  for (const e of entries) {
    assert.equal(typeof e.mountId, 'number');
    assert.equal(typeof e.parentId, 'number');
  }
});

// ---------------------------------------------------------------------------
// removeDir: fail on non-empty; ENOENT no-op; succeeds once emptied/unmounted.
// ---------------------------------------------------------------------------

test('mock removeDir: an empty, unmounted leftover dir is removed', async () => {
  const a = createMockAdapter('leftoverDirs');
  const leftover = `${EXTERNAL_BASE}/wdexternal`;
  assert.ok((await a.listDir(EXTERNAL_BASE))!.includes('wdexternal'));
  await a.removeDir(leftover);
  assert.ok(!(await a.listDir(EXTERNAL_BASE))!.includes('wdexternal'), 'leftover reaped');
});

test('mock removeDir: a dir with non-mount contents (foreign) FAILS (rmdir-only, ENOTEMPTY)', async () => {
  const a = createMockAdapter('leftoverDirs');
  await assert.rejects(() => a.removeDir(`${EXTERNAL_BASE}/someones-backup`), /ENOTEMPTY/);
});

test('mock removeDir: a dir occupied by a (dead) mount FAILS until it is unmounted', async () => {
  const a = createMockAdapter('leftoverDirs');
  const deadDir = `${EXTERNAL_BASE}/wdexternal (3)`;
  await assert.rejects(() => a.removeDir(deadDir), /ENOTEMPTY/);
  await a.exec(['umount', '-l', deadDir]); // lazy-umount the dead mount first
  await a.removeDir(deadDir); // now the empty dir removes cleanly
  assert.ok(!(await a.listDir(EXTERNAL_BASE))!.includes('wdexternal (3)'));
});

test('mock removeDir: a non-existent dir is a no-op (ENOENT)', async () => {
  const a = createMockAdapter('coopHealthy');
  await a.removeDir(`${EXTERNAL_BASE}/does-not-exist`); // resolves, no throw
});

// ---------------------------------------------------------------------------
// v0.2.1: nested leftover trees + statType + nested removeDir semantics.
// ---------------------------------------------------------------------------

test('mock statType: dir / file / symlink / other / null (ENOENT), never dereferencing symlinks', async () => {
  const a = createMockAdapter('coopHealthy');
  a.addExternalDir('leftover', false);
  a.addSubtreeNode(`${EXTERNAL_BASE}/leftover/sub`, 'dir');
  a.addSubtreeNode(`${EXTERNAL_BASE}/leftover/sub/movie.mkv`, 'file');
  a.addSubtreeNode(`${EXTERNAL_BASE}/leftover/sub/link`, 'symlink');
  a.addSubtreeNode(`${EXTERNAL_BASE}/leftover/sub/sock`, 'other');

  assert.equal(await a.statType(`${EXTERNAL_BASE}/leftover`), 'dir');
  assert.equal(await a.statType(`${EXTERNAL_BASE}/leftover/sub`), 'dir');
  assert.equal(await a.statType(`${EXTERNAL_BASE}/leftover/sub/movie.mkv`), 'file');
  assert.equal(await a.statType(`${EXTERNAL_BASE}/leftover/sub/link`), 'symlink', 'symlink is not dereferenced');
  assert.equal(await a.statType(`${EXTERNAL_BASE}/leftover/sub/sock`), 'other');
  assert.equal(await a.statType(`${EXTERNAL_BASE}/leftover/nope`), null, 'missing -> null');
});

test('mock listDir: a nested leftover directory lists its immediate children; an empty dir lists []', async () => {
  const a = createMockAdapter('coopHealthy');
  a.addExternalDir('leftover', false);
  a.addSubtreeNode(`${EXTERNAL_BASE}/leftover/a`, 'dir');
  a.addSubtreeNode(`${EXTERNAL_BASE}/leftover/a/deep`, 'dir');

  assert.deepEqual((await a.listDir(`${EXTERNAL_BASE}/leftover`))!.sort(), ['a']);
  assert.deepEqual(await a.listDir(`${EXTERNAL_BASE}/leftover/a`), ['deep']);
  assert.deepEqual(await a.listDir(`${EXTERNAL_BASE}/leftover/a/deep`), [], 'a leaf empty dir lists []');
});

test('mock removeDir: rmdir-only on a nested tree — fails on a non-empty dir, succeeds once emptied', async () => {
  const a = createMockAdapter('coopHealthy');
  a.addExternalDir('leftover', false);
  a.addSubtreeNode(`${EXTERNAL_BASE}/leftover/a`, 'dir');

  // The parent still holds a child -> ENOTEMPTY.
  await assert.rejects(() => a.removeDir(`${EXTERNAL_BASE}/leftover`), /ENOTEMPTY/);
  // Remove the (empty) child first, then the parent removes cleanly.
  await a.removeDir(`${EXTERNAL_BASE}/leftover/a`);
  await a.removeDir(`${EXTERNAL_BASE}/leftover`);
  assert.ok(!(await a.listDir(EXTERNAL_BASE))!.includes('leftover'));
});

test('mock removeDir: a dir holding a FILE at depth can never be rmdir-ed (data-safety)', async () => {
  const a = createMockAdapter('driftHasFiles');
  const leftover = `${EXTERNAL_BASE}/wdexternal`;
  // The skeleton holds a file, so neither the skeleton nor the leftover rmdir.
  await assert.rejects(() => a.removeDir(`${leftover}/skeleton`), /ENOTEMPTY/);
  await assert.rejects(() => a.removeDir(leftover), /ENOTEMPTY/);
  assert.equal(await a.statType(`${leftover}/skeleton/movie.mkv`), 'file', 'the file is untouched');
});

test('mock: driftReclaimable ships drifted to "(2)" with an empty-tree leftover at the clean name', async () => {
  const a = createMockAdapter('driftReclaimable');
  assert.equal(a.umbrelMountPath(), `${EXTERNAL_BASE}/wdexternal (2)`);
  assert.ok((await a.listDir(EXTERNAL_BASE))!.includes('wdexternal'), 'the clean-name leftover is present');
  assert.equal(await a.statType(`${EXTERNAL_BASE}/wdexternal/skeleton`), 'dir', 'an empty subdir (empty-tree)');
  assert.deepEqual(await a.listDir(`${EXTERNAL_BASE}/wdexternal/skeleton`), [], 'the skeleton is empty');
});

// ---------------------------------------------------------------------------
// docker-exec in-container liveness (the plex-started-before-bind crux, §5).
// ---------------------------------------------------------------------------

test('mock liveOk: plex-started-before-bind sees an EMPTY view until recreated', async () => {
  const a = createMockAdapter('plexStartedBeforeBind');
  const before = await a.exec(['docker', 'exec', PLEX, 'ls', S.containerMediaPath]);
  assert.equal(before.code, 0);
  assert.equal(before.stdout.trim(), '', 'container sees nothing (started before the bind)');

  a.recreatePlex();
  const after = await a.exec(['docker', 'exec', PLEX, 'ls', S.containerMediaPath]);
  assert.equal(after.code, 0);
  assert.ok(after.stdout.includes('Movies'), 'after recreate the live media view appears');
});

test('mock liveOk: coop-healthy exposes the media view immediately', async () => {
  const a = createMockAdapter('coopHealthy');
  const r = await a.exec(['docker', 'exec', PLEX, 'ls', S.containerMediaPath]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('Movies'));
});
