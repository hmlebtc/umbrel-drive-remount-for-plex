/**
 * umbrelOS pre-start boot-hook management (spec section 6a).
 *
 * The hook lives at ${UMBREL_ROOT}/custom-hooks/pre-start — umbrelOS's
 * officially supported, update-persistent hook that runs before umbreld starts.
 * We install a small, marker-delimited block that mounts the drive by UUID.
 *
 * This function is PURE (no filesystem side effects — chmod 755 / mkdir -p /
 * atomic write / backups are the caller's job in restore.ts). It must:
 *   - create the file from scratch (with a #!/bin/sh shebang) when none exists,
 *   - preserve any foreign pre-existing script VERBATIM (never inject a shebang
 *     into someone else's script, never destroy their lines),
 *   - replace ONLY the content between our markers when re-applied, idempotently.
 *
 * The mount command deliberately ends in `|| true` so a failed mount can never
 * block boot. Settings validation (settings.ts) guarantees uuid/mountPoint/
 * fsType contain no shell metacharacters; we ALSO single-quote every templated
 * value below as defense in depth (quoting is always safe because validation
 * bans quotes). The block runs right after local-fs.target — before udev has
 * necessarily settled the USB device — so it waits (bounded, ~30s) for the
 * by-uuid symlink to appear before mounting. Nothing in the block may fail the
 * hook (5-minute boot timeout): the wait loop is bounded and the mount is
 * `|| true`.
 */

export interface HookOptions {
  uuid: string;
  mountPoint: string;
  fsType: string;
}

export interface EnsureHookResult {
  text: string;
  changed: boolean;
  foreignContentPreserved: boolean;
}

const BEGIN_MARKER = '# BEGIN drive-remount-for-plex (managed block - do not edit inside)';
const END_MARKER = '# END drive-remount-for-plex';
const SHEBANG = '#!/bin/sh';

/** The managed block lines, from BEGIN marker to END marker (inclusive). */
function renderBlockLines(opts: HookOptions): string[] {
  const dev = `/dev/disk/by-uuid/${opts.uuid}`;
  return [
    BEGIN_MARKER,
    'i=0',
    `while [ ! -e '${dev}' ] && [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done`,
    `mkdir -p '${opts.mountPoint}'`,
    `if ! mountpoint -q '${opts.mountPoint}'; then`,
    `  mount -t '${opts.fsType}' '${dev}' '${opts.mountPoint}' || true`,
    'fi',
    END_MARKER,
  ];
}

/**
 * True if `text` retains any content other than a leading shebang and our own
 * managed block — i.e. we preserved someone else's lines.
 */
function hasForeignContent(text: string): boolean {
  const lines = text.split('\n');
  const beginIdx = lines.indexOf(BEGIN_MARKER);
  const endIdx = lines.indexOf(END_MARKER);
  const inBlock = (i: number): boolean =>
    beginIdx !== -1 && endIdx !== -1 && i >= beginIdx && i <= endIdx;
  for (let i = 0; i < lines.length; i++) {
    if (inBlock(i)) continue;
    if (i === 0 && lines[i] === SHEBANG) continue;
    if (lines[i]!.trim() === '') continue;
    return true;
  }
  return false;
}

/**
 * Ensure the managed mount block is present and current in the hook script.
 * See the module comment for the three cases handled.
 */
export function ensureHookBlock(existing: string | null, opts: HookOptions): EnsureHookResult {
  const blockLines = renderBlockLines(opts);
  const block = blockLines.join('\n');

  // Case 1: no (or empty) script -> create from scratch with a shebang.
  if (existing === null || existing.trim() === '') {
    return {
      text: `${SHEBANG}\n${block}\n`,
      changed: true,
      foreignContentPreserved: false,
    };
  }

  const lines = existing.split('\n');
  const beginIdx = lines.indexOf(BEGIN_MARKER);
  const endIdx = lines.indexOf(END_MARKER);

  let text: string;
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    // Case 3: replace only the marked block; foreign lines outside untouched.
    const before = lines.slice(0, beginIdx);
    const after = lines.slice(endIdx + 1);
    text = [...before, ...blockLines, ...after].join('\n');
  } else {
    // Case 2: foreign script without markers -> preserve verbatim, append block.
    const separator = existing.endsWith('\n') ? '' : '\n';
    text = `${existing}${separator}${block}\n`;
  }

  return {
    text,
    changed: text !== existing,
    foreignContentPreserved: hasForeignContent(text),
  };
}
