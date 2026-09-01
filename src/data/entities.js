/**
 * How agencies are labelled, in one place.
 *
 * The distinction these labels carry is the whole reason the feature is honest.
 * Half of what the app shows was matched against BetaNYC's agency registry; the
 * other half is a phrase that merely LOOKS like an agency name, matched by
 * pattern and never reviewed by a person. Both are shown, because the registry
 * lists agencies that exist today and marks all 317 active — so the Board of
 * Estimate, the Bureau of the Budget and DoITT can appear only as the second
 * kind, and those are most of the history.
 *
 * A reader must never have to guess which they are looking at. Every list, every
 * graph node and every page header carries the badge.
 */

export const KIND_REGISTRY = "registry";
export const KIND_PROPOSED = "proposed";

export const KIND_LABEL = {
  [KIND_REGISTRY]: "Confirmed",
  [KIND_PROPOSED]: "Proposed",
};

export const KIND_TITLE = {
  [KIND_REGISTRY]: "Matched against BetaNYC's agency registry.",
  [KIND_PROPOSED]:
    "A phrase shaped like an agency name, matched by pattern and not yet reviewed. " +
    "Dissolved bodies can only appear this way — the registry holds active agencies.",
};

/** The badge class, so styles.css owns the colours rather than each view. */
export const kindClass = (kind) =>
  `badge kind-${kind === KIND_PROPOSED ? "proposed" : "registry"}`;

/**
 * A LIST column does not arrive as a JS array: duckdb-wasm hands back an Arrow
 * Vector and @duckdb/node-api a {items} wrapper. Same normalization Detail.jsx
 * already does for `source_pages`, lifted here because three views now need it.
 */
export const toArray = (v) => (v == null ? [] : Array.from(v.items ?? v));

/**
 * Cut the text at every mention, so the raw view can mark them.
 *
 * The offsets index into `full_text` and upstream proves
 * `full_text[start:end] === text` for all 23,504 finds, so nothing here searches
 * the text again — it slices at the recorded positions and trusts them.
 *
 * Overlaps are real. The scan matches the longest name at any spot, but two
 * agencies can share one span when a name pins down neither, and pass two can
 * propose a phrase that contains a confirmed name. Spans are therefore merged
 * before slicing: a character is inside a mention or it is not, and marking it
 * twice would nest one <mark> in another.
 *
 * @returns {Array<{text: string, marked: boolean, ids: string[]}>}
 */
export function markSegments(text, spans) {
  const body = String(text ?? "");
  if (!body || !spans?.length) return [{ text: body, marked: false, ids: [] }];

  const sorted = [...spans]
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      if (!last.ids.includes(span.entity_id)) last.ids.push(span.entity_id);
    } else {
      merged.push({ start: span.start, end: span.end, ids: [span.entity_id] });
    }
  }

  const out = [];
  let at = 0;
  for (const span of merged) {
    const start = Math.max(at, Math.min(span.start, body.length));
    const end = Math.max(start, Math.min(span.end, body.length));
    if (start > at) out.push({ text: body.slice(at, start), marked: false, ids: [] });
    if (end > start) out.push({ text: body.slice(start, end), marked: true, ids: span.ids });
    at = end;
  }
  if (at < body.length) out.push({ text: body.slice(at), marked: false, ids: [] });
  return out;
}

/**
 * Make a classification readable, whichever way the registry wrote it.
 *
 * Two spellings are genuinely in the data: the bulk import writes
 * "Mayoral Agency" and the hand-authored seed records write "mayoral-agency".
 * Both mean the same thing, and showing a reader a slug where their neighbour
 * gets a phrase looks like a bug. Only the slug form is touched -- a value that
 * already has a capital or a space is left exactly as its source wrote it.
 */
export function classificationLabel(value) {
  const text = String(value ?? "");
  if (!text || !/^[a-z0-9-]+$/.test(text)) return text;
  return text
    .split("-")
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * The registry's alternate and former names, minus what the page already shows.
 *
 * The registry repeats the acronym inside `other_names`, and sometimes the
 * official name too. Both already have their own line on an agency page, and
 * printing them twice reads as a mistake rather than as thoroughness.
 */
export function otherNames(row) {
  const seen = new Set(
    [row?.display_name, row?.name, row?.short_name].filter(Boolean).map(norm)
  );
  return toArray(row?.other_names).filter((n) => n && !seen.has(norm(n)));
}

/**
 * A comparison key for deciding two names are the same name.
 *
 * Deliberately NOT `normalizeName` from the build script. That one mints entity
 * ids and has to match `lineage/normalize.py` character for character, which
 * turns an apostrophe into a space -- so "Mayor's Office" keys as `mayor s
 * office` and never equals "Mayors Office". Correct for an id, wrong here: this
 * only decides whether to print a name twice, and printing both spellings of one
 * name is exactly the noise it exists to remove. Dropping the apostrophe first
 * is what makes them agree. Keep the two apart.
 */
const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * The seven reorganization kinds, read as English.
 *
 * Upstream names them after the verb phrase in the sentence -- `transfers_to`,
 * `merges_into`. On a page ABOUT the agency the sentence acts on, the passive
 * reads right: this body was established, was renamed, was transferred to
 * another. The map lives here because one file owns every agency label.
 */
export const EVENT_LABEL = {
  establishes: "established",
  continues: "continued",
  renames: "renamed",
  transfers_to: "transferred to",
  merges_into: "merged into",
  succeeds: "succeeded by",
  abolishes: "abolished",
};

/** The kinds that START a body, and so date the left end of its lineage. */
export const EVENT_KINDS_START = new Set(["establishes", "continues"]);

/** The one kind that ENDS a body. */
export const EVENT_KINDS_END = new Set(["abolishes"]);

/**
 * The kinds that connect TWO bodies, and so are the only ones that draw a chain.
 *
 * Only 44 events in the corpus fill both a `from` and a `to`, and 9 of those put
 * one agency on both sides. So the chain is a short strip, never a family tree,
 * and most agencies have none at all.
 */
export const EVENT_KINDS_LINK = new Set(["renames", "transfers_to", "merges_into", "succeeds"]);

/**
 * Sort one agency's events into the shapes the chain strip draws.
 *
 * `before` and `after` are the links to another body. `self` is the case that
 * would look like a bug if it were drawn as an arrow: the registry gives the
 * Department of Information Technology and Telecommunications and the Office of
 * Technology and Innovation the same slug, so the 2022 rename has one id on both
 * sides. It is a rename OF this body and belongs on the box, not beside it.
 *
 * `start` and `end` are the caps -- the order that created the body and the one
 * that shut it down. Several of each can exist: a body is re-established, or
 * continued by a later mayor, and the strip shows the run rather than picking one.
 */
export function chainOf(events, entityId) {
  const out = { before: [], after: [], self: [], start: [], end: [] };
  for (const e of events ?? []) {
    const from = e.from_id;
    const to = e.to_id;
    if (EVENT_KINDS_LINK.has(e.kind) && from && to && from === to && from === entityId) {
      out.self.push(e);
    } else if (EVENT_KINDS_LINK.has(e.kind) && to === entityId && from !== entityId) {
      out.before.push(e);
    } else if (EVENT_KINDS_LINK.has(e.kind) && from === entityId && to !== entityId) {
      out.after.push(e);
    } else if (EVENT_KINDS_START.has(e.kind) && to === entityId) {
      out.start.push(e);
    } else if (EVENT_KINDS_END.has(e.kind)) {
      out.end.push(e);
    }
  }
  return out;
}

/**
 * The other body an event names, from the point of view of one agency.
 *
 * Returns what the row should print: an id to link to when the name landed on a
 * page, and a name to print plainly when it did not. 13 role names in the corpus
 * have no page, and a dead link would be worse than plain text.
 */
export function counterpart(event, entityId) {
  const mine = event.from_id === entityId && event.from_id !== null;
  const id = mine ? event.to_id : event.from_id;
  const name = mine
    ? (event.to_display_name ?? event.to_name)
    : (event.from_display_name ?? event.from_name);
  const kind = mine ? event.to_entity_kind : event.from_entity_kind;
  if (!name) return null;
  return { entity_id: id ?? null, name, kind: kind ?? null };
}
