// Tests for composePatch.ts (spec section 6(b), section 10 frozen signature):
//
//   export function ensureVolumeLine(
//     composeText: string,
//     opts: { hostPath: string; containerPath: string },
//   ): { text: string; changed: boolean; alreadyPresent: boolean; problems: string[] }
//
// composePatch.ts is owned by B1 and does not exist at the time this file was
// written (B1 builds in parallel) — this test is written strictly against the
// frozen signature above and the behavior described in spec section 6(b).

import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureVolumeLine } from "./composePatch.js";
import {
  CONTAINER_MEDIA_PATH,
  HOST_MEDIA_PATH,
  PLEX_COMPOSE_BASIC,
  PLEX_COMPOSE_BASIC_ALREADY_PATCHED,
  PLEX_COMPOSE_COMMENT_INTERLEAVED_ALREADY_PATCHED,
  PLEX_COMPOSE_COMMENT_INTERLEAVED_UNPATCHED,
  PLEX_COMPOSE_CRLF_ALREADY_PATCHED,
  PLEX_COMPOSE_CRLF_BASIC,
  PLEX_COMPOSE_NO_SERVER_SERVICE,
  PLEX_COMPOSE_NO_VOLUMES_KEY,
  PLEX_COMPOSE_RESERIALIZED,
  PLEX_COMPOSE_RESERIALIZED_ALREADY_PATCHED,
  PLEX_COMPOSE_TABS,
  PLEX_COMPOSE_TRAILING_COMMENT_VOLUMES,
  TARGET_VOLUME_LINE,
} from "./fixtures/composeFixtures.js";

const OPTS = { hostPath: HOST_MEDIA_PATH, containerPath: CONTAINER_MEDIA_PATH };

// Every original line of `original` must appear, in the same relative order,
// among the lines of `patched` — i.e. nothing was reordered or removed
// (insertions are fine).
function assertOriginalLinesPreservedInOrder(original: string, patched: string): void {
  const origLines = original.split("\n");
  const newLines = patched.split("\n");
  let i = 0;
  for (const line of newLines) {
    if (i < origLines.length && line === origLines[i]) i++;
  }
  assert.equal(
    i,
    origLines.length,
    `expected all ${origLines.length} original lines to appear in order in the patched text (matched ${i})`,
  );
}

// ---------------------------------------------------------------------------
// Idempotence: patching twice is the same as patching once.
// ---------------------------------------------------------------------------

test("idempotence: patching an already-patched result a second time is a no-op", () => {
  const first = ensureVolumeLine(PLEX_COMPOSE_BASIC, OPTS);
  assert.equal(first.changed, true);
  assert.equal(first.alreadyPresent, false);
  assert.deepEqual(first.problems, []);
  assert.ok(first.text.includes(HOST_MEDIA_PATH + ":" + CONTAINER_MEDIA_PATH));

  const second = ensureVolumeLine(first.text, OPTS);
  assert.equal(second.changed, false);
  assert.equal(second.alreadyPresent, true);
  assert.deepEqual(second.problems, []);
  assert.equal(second.text, first.text, "patching twice must equal patching once");
});

// ---------------------------------------------------------------------------
// Realistic umbreld-INSTALLED plex compose fixture.
// ---------------------------------------------------------------------------

test("umbreld-installed plex compose: patches cleanly and preserves umbreld-injected fields", () => {
  const result = ensureVolumeLine(PLEX_COMPOSE_BASIC, OPTS);
  assert.equal(result.changed, true);
  assert.equal(result.alreadyPresent, false);
  assert.deepEqual(result.problems, []);

  // umbreld-guaranteed fields must survive the patch untouched.
  assert.ok(result.text.includes("container_name: plex_server_1"));
  assert.ok(result.text.includes("network_mode: host"));
  assert.ok(result.text.includes("${APP_DATA_DIR}/data/config:/config"));
  assert.ok(result.text.includes("${UMBREL_ROOT}/home/Downloads:/downloads"));

  // New line inserted matching sibling indentation (6 spaces + "- ").
  assert.ok(
    result.text.includes("\n      - " + HOST_MEDIA_PATH + ":" + CONTAINER_MEDIA_PATH),
    "inserted volume line should match the 6-space sibling indentation",
  );

  assertOriginalLinesPreservedInOrder(PLEX_COMPOSE_BASIC, result.text);
});

// ---------------------------------------------------------------------------
// umbreld-reserialized variant: different indentation, quoted list items.
// ---------------------------------------------------------------------------

test("umbreld-reserialized compose: different indentation/quoting still patches correctly", () => {
  const result = ensureVolumeLine(PLEX_COMPOSE_RESERIALIZED, OPTS);
  assert.equal(result.changed, true);
  assert.equal(result.alreadyPresent, false);
  assert.deepEqual(result.problems, []);

  assert.ok(result.text.includes('container_name: "plex_server_1"'));
  assert.ok(result.text.includes('network_mode: "host"'));

  // New line's content (ignoring quoting) must equal hostPath:containerPath,
  // indented to match the 9-space sibling list items.
  const lines = result.text.split("\n");
  const inserted = lines.find((l) => {
    const stripped = l.trim().replace(/^-\s*/, "").replace(/^"|"$/g, "");
    return stripped === HOST_MEDIA_PATH + ":" + CONTAINER_MEDIA_PATH;
  });
  assert.ok(inserted, "expected a newly inserted line for the target volume");
  const leadingSpaces = inserted!.match(/^ */)![0].length;
  assert.equal(leadingSpaces, 9, "inserted line should match sibling (9-space) indentation");

  assertOriginalLinesPreservedInOrder(PLEX_COMPOSE_RESERIALIZED, result.text);
});

// ---------------------------------------------------------------------------
// Detects an existing target line whether quoted or not.
// ---------------------------------------------------------------------------

test("detects an already-present UNQUOTED target line and makes no change", () => {
  const result = ensureVolumeLine(PLEX_COMPOSE_BASIC_ALREADY_PATCHED, OPTS);
  assert.equal(result.alreadyPresent, true);
  assert.equal(result.changed, false);
  assert.deepEqual(result.problems, []);
  assert.equal(result.text, PLEX_COMPOSE_BASIC_ALREADY_PATCHED);
});

test("detects an already-present QUOTED target line and makes no change", () => {
  const result = ensureVolumeLine(PLEX_COMPOSE_RESERIALIZED_ALREADY_PATCHED, OPTS);
  assert.equal(result.alreadyPresent, true);
  assert.equal(result.changed, false);
  assert.deepEqual(result.problems, []);
  assert.equal(result.text, PLEX_COMPOSE_RESERIALIZED_ALREADY_PATCHED);
});

// ---------------------------------------------------------------------------
// Missing volumes: key or missing server: service -> problems[], no text change.
// ---------------------------------------------------------------------------

test("missing volumes: key under server: -> problems reported, text unchanged", () => {
  const result = ensureVolumeLine(PLEX_COMPOSE_NO_VOLUMES_KEY, OPTS);
  assert.equal(result.changed, false);
  assert.equal(result.text, PLEX_COMPOSE_NO_VOLUMES_KEY);
  assert.ok(result.problems.length > 0, "expected at least one problem reported");
});

test("missing server: service entirely -> problems reported, text unchanged", () => {
  const result = ensureVolumeLine(PLEX_COMPOSE_NO_SERVER_SERVICE, OPTS);
  assert.equal(result.changed, false);
  assert.equal(result.text, PLEX_COMPOSE_NO_SERVER_SERVICE);
  assert.ok(result.problems.length > 0, "expected at least one problem reported");
});

// ---------------------------------------------------------------------------
// Never reorders or removes existing lines.
// ---------------------------------------------------------------------------

test("never reorders or removes existing lines (basic fixture)", () => {
  const result = ensureVolumeLine(PLEX_COMPOSE_BASIC, OPTS);
  assertOriginalLinesPreservedInOrder(PLEX_COMPOSE_BASIC, result.text);
  // Also: no original line was mutated in place (every original line is
  // still present verbatim somewhere), only an insertion happened.
  const origLines = PLEX_COMPOSE_BASIC.split("\n");
  const newLines = new Set(result.text.split("\n"));
  for (const line of origLines) {
    assert.ok(newLines.has(line), `original line lost or mutated: ${JSON.stringify(line)}`);
  }
});

test("never reorders or removes existing lines (reserialized fixture)", () => {
  const result = ensureVolumeLine(PLEX_COMPOSE_RESERIALIZED, OPTS);
  assertOriginalLinesPreservedInOrder(PLEX_COMPOSE_RESERIALIZED, result.text);
  const origLines = PLEX_COMPOSE_RESERIALIZED.split("\n");
  const newLines = new Set(result.text.split("\n"));
  for (const line of origLines) {
    assert.ok(newLines.has(line), `original line lost or mutated: ${JSON.stringify(line)}`);
  }
});

// ---------------------------------------------------------------------------
// Regression (a): trailing #-comment on the `volumes:` key is NOT inline flow.
// Old bug: rewrote the key into `volumes: [# bind mounts, /mnt/...]`, dangling
// the block items below it (invalid YAML — Plex could not start).
// ---------------------------------------------------------------------------

function countTargetItems(text: string): number {
  return text.split("\n").filter((l) => {
    const stripped = l.trim().replace(/^-\s*/, "").replace(/^"|"$/g, "");
    return stripped === TARGET_VOLUME_LINE;
  }).length;
}

test("trailing comment on volumes: key -> block insert, key line never rewritten", () => {
  const result = ensureVolumeLine(PLEX_COMPOSE_TRAILING_COMMENT_VOLUMES, OPTS);
  assert.equal(result.changed, true);
  assert.equal(result.alreadyPresent, false);
  assert.deepEqual(result.problems, []);

  // The `volumes:` line is preserved verbatim, comment and all.
  assert.ok(
    result.text.includes("    volumes:  # bind mounts"),
    "the commented volumes: key line must be preserved untouched",
  );
  // It must NOT have been mangled into an inline flow array.
  assert.ok(!result.text.includes("volumes: ["), "must not rewrite into an inline flow array");
  assert.ok(!result.text.includes("# bind mounts,"), "comment must not be swept into an array element");

  // The new item is inserted as a block sibling at the 6-space indentation,
  // after the last existing item.
  assert.ok(result.text.includes("\n      - " + TARGET_VOLUME_LINE));
  assert.equal(countTargetItems(result.text), 1, "exactly one media bind item");
  assertOriginalLinesPreservedInOrder(PLEX_COMPOSE_TRAILING_COMMENT_VOLUMES, result.text);
});

// ---------------------------------------------------------------------------
// Regression (b): CRLF files. Idempotence must hold byte-for-byte; a fresh
// insert must use CRLF, not an LF line jammed in as the first item.
// ---------------------------------------------------------------------------

test("CRLF already-patched compose -> alreadyPresent, no change, byte-identical", () => {
  const result = ensureVolumeLine(PLEX_COMPOSE_CRLF_ALREADY_PATCHED, OPTS);
  assert.equal(result.alreadyPresent, true);
  assert.equal(result.changed, false);
  assert.deepEqual(result.problems, []);
  assert.equal(result.text, PLEX_COMPOSE_CRLF_ALREADY_PATCHED, "output must be byte-identical on CRLF");
});

test("CRLF unpatched compose -> inserts with CRLF, and is idempotent", () => {
  const first = ensureVolumeLine(PLEX_COMPOSE_CRLF_BASIC, OPTS);
  assert.equal(first.changed, true);
  assert.equal(first.alreadyPresent, false);
  // Inserted line carries CRLF (not a bare LF), and it is not the first item.
  assert.ok(
    first.text.includes("      - " + TARGET_VOLUME_LINE + "\r\n"),
    "inserted line must use CRLF",
  );
  assert.ok(!first.text.includes("\r\r"), "no doubled CR");
  assert.ok(!/[^\r]\n/.test(first.text), "no lone LF (mixed EOL) introduced");
  assert.equal(countTargetItems(first.text), 1);

  const second = ensureVolumeLine(first.text, OPTS);
  assert.equal(second.alreadyPresent, true);
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text, "CRLF patch must be idempotent");
});

// ---------------------------------------------------------------------------
// Regression (c): blank / comment-only lines between volume items.
// Old bug: collection stopped at the first blank/comment, missing a target
// listed after it, and inserted a duplicate above the comment.
// ---------------------------------------------------------------------------

test("comment/blank interleaved, target already present after a comment -> no change", () => {
  const result = ensureVolumeLine(PLEX_COMPOSE_COMMENT_INTERLEAVED_ALREADY_PATCHED, OPTS);
  assert.equal(result.alreadyPresent, true);
  assert.equal(result.changed, false);
  assert.deepEqual(result.problems, []);
  assert.equal(result.text, PLEX_COMPOSE_COMMENT_INTERLEAVED_ALREADY_PATCHED);
  assert.equal(countTargetItems(result.text), 1, "must not duplicate the existing bind");
});

test("comment/blank interleaved, not patched -> single clean insert after last item", () => {
  const result = ensureVolumeLine(PLEX_COMPOSE_COMMENT_INTERLEAVED_UNPATCHED, OPTS);
  assert.equal(result.changed, true);
  assert.equal(result.alreadyPresent, false);
  assert.deepEqual(result.problems, []);
  assert.equal(countTargetItems(result.text), 1);
  // Inserted after the downloads item (the last real item), not above the comment.
  const lines = result.text.split("\n");
  const downloadsIdx = lines.findIndex((l) => l.includes("home/Downloads:/downloads"));
  const targetIdx = lines.findIndex((l) => l.trim().replace(/^-\s*/, "") === TARGET_VOLUME_LINE);
  assert.ok(downloadsIdx >= 0 && targetIdx === downloadsIdx + 1, "target must be inserted after the last item");
  assertOriginalLinesPreservedInOrder(PLEX_COMPOSE_COMMENT_INTERLEAVED_UNPATCHED, result.text);
});

// ---------------------------------------------------------------------------
// Regression (d): tab-indented compose -> clean insert OR problems[], never
// corruption.
// ---------------------------------------------------------------------------

test("tab-indented compose -> clean insert or problems[], never corruption", () => {
  const result = ensureVolumeLine(PLEX_COMPOSE_TABS, OPTS);
  if (result.changed) {
    assert.equal(result.alreadyPresent, false);
    assert.deepEqual(result.problems, []);
    assert.equal(countTargetItems(result.text), 1);
    assertOriginalLinesPreservedInOrder(PLEX_COMPOSE_TABS, result.text);
  } else {
    assert.ok(result.problems.length > 0, "if not inserted, a problem must be reported");
    assert.equal(result.text, PLEX_COMPOSE_TABS, "unchanged text -> no corruption");
    assert.equal(result.alreadyPresent, false);
  }
});
