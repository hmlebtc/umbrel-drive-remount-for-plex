/**
 * Idempotent patcher for Plex's installed docker-compose.yml (spec section 6b).
 *
 * umbreld force-injects `container_name: plex_server_1` and may reserialize the
 * file (different indentation, quoted scalars/list items, reordered keys) on
 * every install/update/start. We must add ONE media bind-mount line to the
 * `server` service's `volumes:` list without disturbing anything else — no
 * reordering, no reformatting, no removed lines. We therefore operate on raw
 * text lines (never a YAML round-trip, which would itself reformat the file
 * and could fight umbreld's own serializer) and only ever INSERT a single line.
 *
 * Robustness rules the scanner MUST honour (regression-tested):
 *   - A trailing comment on the `volumes:` key (e.g. `volumes:  # bind mounts`)
 *     is NOT an inline flow array. We treat the key as inline-flow ONLY when the
 *     text after stripping a trailing `#`-comment starts with `[`. A bare or
 *     commented `volumes:` with block children below is BLOCK style, and we NEVER
 *     rewrite the `volumes:` line when block-style children exist.
 *   - CRLF files: we detect the file's EOL, strip `\r` before matching every
 *     line, and emit any inserted line with the detected EOL, so idempotence
 *     holds byte-for-byte on CRLF input (no duplicate/mixed-EOL insertion).
 *   - Blank lines and comment-only lines between volume items do not end the
 *     list: we skip them and only stop at a non-blank line whose indent is
 *     <= the `volumes:` key indent. ALL items are checked for already-present
 *     and a new item is inserted after the LAST item.
 */

export interface EnsureVolumeOptions {
  hostPath: string;
  containerPath: string;
}

export interface EnsureVolumeResult {
  text: string;
  changed: boolean;
  alreadyPresent: boolean;
  problems: string[];
}

interface ServiceLocation {
  index: number;
  indent: number;
}

interface VolumesKeyLocation {
  index: number;
  indent: number;
  /** Raw text after `volumes:` on the same line (trimmed; may include a comment). */
  rest: string;
}

interface VolumeItem {
  index: number;
  indent: number;
  /** The item text after the leading `- `, quotes not stripped. */
  raw: string;
}

/** Leading-space count (spaces only — tab-indented files are handled as problems). */
function indentOf(line: string): number {
  const m = line.match(/^ */);
  return m ? m[0].length : 0;
}

/** Strip surrounding single/double quotes and whitespace from a scalar. */
function unquote(value: string): string {
  let v = value.trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      v = v.slice(1, -1);
    }
  }
  return v.trim();
}

/**
 * Remove a trailing YAML `#`-comment from a single line's value. A `#` only
 * begins a comment when it is at the start or preceded by whitespace and it is
 * not inside quotes or inside a `[...]` flow sequence. Returns the code portion
 * (comment and its leading whitespace removed only from the tail).
 */
function stripTrailingComment(s: string): string {
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '[') {
      depth++;
    } else if (ch === ']') {
      if (depth > 0) depth--;
    } else if (ch === '#' && depth === 0 && (i === 0 || /\s/.test(s[i - 1]!))) {
      return s.slice(0, i);
    }
  }
  return s;
}

/**
 * If the `volumes:` key's inline remainder is an inline flow sequence, return
 * its bracketed body text; otherwise null (block style / bare / commented key).
 */
function inlineFlowBody(rest: string): string | null {
  const code = stripTrailingComment(rest).trim();
  return code.startsWith('[') ? code : null;
}

/** Locate the `server:` service key (nested under services:, so indent > 0). */
function locateServerService(lines: string[]): ServiceLocation | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(/^(\s*)server:\s*$/);
    if (m && m[1]!.length > 0) {
      return { index: i, indent: m[1]!.length };
    }
  }
  return null;
}

function locateNamedService(lines: string[], name: string): ServiceLocation | null {
  const re = new RegExp(`^(\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(re);
    if (m && m[1]!.length > 0) return { index: i, indent: m[1]!.length };
  }
  return null;
}

/** Locate the `volumes:` key within the given service's block. */
function locateVolumesKey(lines: string[], service: ServiceLocation): VolumesKeyLocation | null {
  for (let i = service.index + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const ind = indentOf(line);
    // A line at or below the service's own indent ends the service block.
    if (ind <= service.indent) return null;
    const m = line.match(/^(\s*)volumes:\s*(.*)$/);
    if (m && m[1]!.length > service.indent) {
      return { index: i, indent: m[1]!.length, rest: m[2]!.trim() };
    }
  }
  return null;
}

/**
 * Collect the block-style list items directly under a volumes: key. Blank lines
 * and comment-only lines are SKIPPED (they do not end the list); collection
 * stops only at a non-blank line whose indent is <= the volumes: key indent, or
 * at a non-blank, non-comment line that is not a `- ` list item.
 */
function collectVolumeItems(lines: string[], vol: VolumesKeyLocation): VolumeItem[] {
  const items: VolumeItem[] = [];
  for (let i = vol.index + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue; // blank line: skip, do not end the block
    const ind = indentOf(line);
    if (ind <= vol.indent) break; // dedent to/below the key: end of the block
    if (line.trim().startsWith('#')) continue; // comment-only line: skip
    const m = line.match(/^(\s*)-\s?(.*)$/);
    if (!m) break; // a more-indented non-item line: stop to stay safe
    items.push({ index: i, indent: m[1]!.length, raw: m[2]! });
  }
  return items;
}

/** Split an inline flow sequence body like `[a, "b", c]` into element strings. */
function splitInlineArray(inline: string): string[] {
  let body = inline.trim();
  if (body.startsWith('[')) body = body.slice(1);
  if (body.endsWith(']')) body = body.slice(0, -1);
  if (body.trim() === '') return [];
  return body.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/** Detect the dominant EOL of the text (CRLF only if any \r\n is present). */
function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Split into lines and a \r-stripped parallel view for matching. */
function splitLines(text: string): { raw: string[]; clean: string[] } {
  const raw = text.split('\n');
  const clean = raw.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  return { raw, clean };
}

/**
 * Extract the (source, destination) pairs of every bind in a service's
 * volumes list. Used by the mock adapter to simulate what `docker compose up`
 * would mount; not part of the patch path. Env vars are left un-substituted.
 */
export function parseServiceVolumes(
  composeText: string,
  serviceName = 'server',
): Array<{ source: string; destination: string }> {
  const { clean } = splitLines(composeText);
  const svc = serviceName === 'server' ? locateServerService(clean) : locateNamedService(clean, serviceName);
  if (!svc) return [];
  const vol = locateVolumesKey(clean, svc);
  if (!vol) return [];
  const result: Array<{ source: string; destination: string }> = [];
  const push = (spec: string): void => {
    const s = unquote(spec);
    const colon = s.indexOf(':');
    if (colon <= 0) return;
    const rest = s.slice(colon + 1);
    const destEnd = rest.indexOf(':');
    const destination = destEnd === -1 ? rest : rest.slice(0, destEnd);
    result.push({ source: s.slice(0, colon), destination });
  };
  const body = inlineFlowBody(vol.rest);
  if (body !== null) {
    for (const part of splitInlineArray(body)) push(part);
  } else {
    for (const item of collectVolumeItems(clean, vol)) push(item.raw);
  }
  return result;
}

/**
 * Ensure the `${hostPath}:${containerPath}` bind exists in the Plex `server`
 * service's volumes list. Idempotent: if the target is already present (quoted
 * or not) nothing changes and `alreadyPresent` is true (output is byte-identical
 * to the input, including its original EOLs). If the server service or its
 * volumes key is missing, the text is returned unchanged with a populated
 * `problems` array (we never guess where to inject). On success a single new
 * list item is INSERTED (matching sibling indentation, using the file's EOL)
 * after the last existing item — no other line is touched, moved, or reformatted.
 */
export function ensureVolumeLine(
  composeText: string,
  opts: EnsureVolumeOptions,
): EnsureVolumeResult {
  const target = `${opts.hostPath}:${opts.containerPath}`;
  const eol = detectEol(composeText);
  const { raw, clean } = splitLines(composeText);
  const withEol = (content: string): string => (eol === '\r\n' ? `${content}\r` : content);

  const service = locateServerService(clean);
  if (!service) {
    return {
      text: composeText,
      changed: false,
      alreadyPresent: false,
      problems: ["no 'server' service found in the Plex compose file"],
    };
  }

  const vol = locateVolumesKey(clean, service);
  if (!vol) {
    return {
      text: composeText,
      changed: false,
      alreadyPresent: false,
      problems: ["no 'volumes:' key found under the 'server' service"],
    };
  }

  const flow = inlineFlowBody(vol.rest);

  // Inline flow-sequence form: `volumes: ["a:b", "c:d"]` or `volumes: []`.
  // We ONLY take this path when the code after stripping a trailing comment
  // starts with `[` — a commented/bare key falls through to block handling.
  if (flow !== null) {
    const elements = splitInlineArray(flow);
    if (elements.some((e) => unquote(e) === target)) {
      return { text: composeText, changed: false, alreadyPresent: true, problems: [] };
    }
    const rebuilt = [...elements, target];
    const keyIndentStr = ' '.repeat(vol.indent);
    const commentPart = vol.rest.slice(stripTrailingComment(vol.rest).length).trim();
    const suffix = commentPart ? `  ${commentPart}` : '';
    raw[vol.index] = withEol(`${keyIndentStr}volumes: [${rebuilt.join(', ')}]${suffix}`);
    return { text: raw.join('\n'), changed: true, alreadyPresent: false, problems: [] };
  }

  // Block-style list (this includes a bare `volumes:` and a `volumes:  # comment`
  // that has block children below — we NEVER rewrite that key line).
  const items = collectVolumeItems(clean, vol);
  if (items.some((it) => unquote(it.raw) === target)) {
    return { text: composeText, changed: false, alreadyPresent: true, problems: [] };
  }

  const itemIndent = items.length > 0 ? items[0]!.indent : vol.indent + 2;
  const insertAt = items.length > 0 ? items[items.length - 1]!.index + 1 : vol.index + 1;
  const newLine = `${' '.repeat(itemIndent)}- ${target}`;
  raw.splice(insertAt, 0, withEol(newLine));

  return { text: raw.join('\n'), changed: true, alreadyPresent: false, problems: [] };
}
