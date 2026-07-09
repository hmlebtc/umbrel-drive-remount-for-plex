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
  /** Inline value after `volumes:` on the same line, or '' for block style. */
  inline: string;
}

interface VolumeItem {
  index: number;
  indent: number;
  /** The item text after the leading `- `, quotes not stripped. */
  raw: string;
}

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
      return { index: i, indent: m[1]!.length, inline: m[2]!.trim() };
    }
  }
  return null;
}

/** Collect the block-style list items directly under a volumes: key. */
function collectVolumeItems(lines: string[], vol: VolumesKeyLocation): VolumeItem[] {
  const items: VolumeItem[] = [];
  for (let i = vol.index + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') break;
    const ind = indentOf(line);
    if (ind <= vol.indent) break;
    const m = line.match(/^(\s*)-\s?(.*)$/);
    if (!m) break;
    items.push({ index: i, indent: m[1]!.length, raw: m[2]! });
  }
  return items;
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
  const lines = composeText.split('\n');
  const svc = serviceName === 'server' ? locateServerService(lines) : locateNamedService(lines, serviceName);
  if (!svc) return [];
  const vol = locateVolumesKey(lines, svc);
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
  if (vol.inline !== '') {
    for (const part of splitInlineArray(vol.inline)) push(part);
  } else {
    for (const item of collectVolumeItems(lines, vol)) push(item.raw);
  }
  return result;
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

/** Split an inline flow sequence body like `[a, "b", c]` into element strings. */
function splitInlineArray(inline: string): string[] {
  let body = inline.trim();
  if (body.startsWith('[')) body = body.slice(1);
  if (body.endsWith(']')) body = body.slice(0, -1);
  if (body.trim() === '') return [];
  return body.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * Ensure the `${hostPath}:${containerPath}` bind exists in the Plex `server`
 * service's volumes list. Idempotent: if the target is already present (quoted
 * or not) nothing changes and `alreadyPresent` is true. If the server service
 * or its volumes key is missing, the text is returned unchanged with a
 * populated `problems` array (we never guess where to inject). On success a
 * single new list item is INSERTED (matching sibling indentation) after the
 * last existing item — no other line is touched, moved, or reformatted.
 */
export function ensureVolumeLine(
  composeText: string,
  opts: EnsureVolumeOptions,
): EnsureVolumeResult {
  const target = `${opts.hostPath}:${opts.containerPath}`;
  const lines = composeText.split('\n');

  const service = locateServerService(lines);
  if (!service) {
    return {
      text: composeText,
      changed: false,
      alreadyPresent: false,
      problems: ["no 'server' service found in the Plex compose file"],
    };
  }

  const vol = locateVolumesKey(lines, service);
  if (!vol) {
    return {
      text: composeText,
      changed: false,
      alreadyPresent: false,
      problems: ["no 'volumes:' key found under the 'server' service"],
    };
  }

  // Inline flow-sequence form: `volumes: ["a:b", "c:d"]` or `volumes: []`.
  if (vol.inline !== '') {
    const elements = splitInlineArray(vol.inline);
    if (elements.some((e) => unquote(e) === target)) {
      return { text: composeText, changed: false, alreadyPresent: true, problems: [] };
    }
    const rebuilt = [...elements, target];
    const keyIndentStr = ' '.repeat(vol.indent);
    lines[vol.index] = `${keyIndentStr}volumes: [${rebuilt.join(', ')}]`;
    return { text: lines.join('\n'), changed: true, alreadyPresent: false, problems: [] };
  }

  // Block-style list.
  const items = collectVolumeItems(lines, vol);
  if (items.some((it) => unquote(it.raw) === target)) {
    return { text: composeText, changed: false, alreadyPresent: true, problems: [] };
  }

  const itemIndent = items.length > 0 ? items[0]!.indent : vol.indent + 2;
  const insertAt = items.length > 0 ? items[items.length - 1]!.index + 1 : vol.index + 1;
  const newLine = `${' '.repeat(itemIndent)}- ${target}`;
  lines.splice(insertAt, 0, newLine);

  return { text: lines.join('\n'), changed: true, alreadyPresent: false, problems: [] };
}
