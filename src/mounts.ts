/**
 * /proc/1/mounts parsing (spec section 4).
 *
 * The kernel encodes spaces/tabs/newlines/backslashes in the device and mount
 * point fields as octal escapes (\040, \011, \012, \134). We decode those, and
 * expose findMount() which — critically — returns the LAST entry for a given
 * target, because when a target is mounted more than once the kernel lists the
 * bottom-most (currently active / top-of-stack) mount last.
 */

export interface MountEntry {
  source: string;
  target: string;
  fsType: string;
  options: string[];
}

/** Decode /proc-style octal escape sequences (e.g. `\040` -> space). */
function decodeOctalEscapes(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, oct: string) =>
    String.fromCharCode(parseInt(oct, 8)),
  );
}

/**
 * Parse the raw text of /proc/<pid>/mounts into structured entries. Blank
 * lines and malformed (< 4 field) lines are skipped; only the first four
 * fields (source, target, fstype, options) are retained.
 */
export function parseProcMounts(text: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    const parts = raw.split(/\s+/);
    if (parts.length < 4) continue;
    const source = parts[0]!;
    const target = parts[1]!;
    const fsType = parts[2]!;
    const options = parts[3]!;
    out.push({
      source: decodeOctalEscapes(source),
      target: decodeOctalEscapes(target),
      fsType,
      options: options.split(','),
    });
  }
  return out;
}

/**
 * Return the active mount for `target`, or null if not mounted. When a target
 * appears multiple times, the LAST occurrence wins (it is the top-most mount).
 * Matching is on the exact, decoded target — never a prefix — so /mnt/wd and
 * /mnt/wdexternal are never confused.
 */
export function findMount(mounts: MountEntry[], target: string): MountEntry | null {
  let found: MountEntry | null = null;
  for (const m of mounts) {
    if (m.target === target) found = m;
  }
  return found;
}
