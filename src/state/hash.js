/**
 * URL-hash state, as pure functions.
 *
 * No router: the sibling qa-ui app deep-links via the hash and this follows the
 * same convention. Extracted into pure read/write helpers specifically so the
 * round-trip is unit-testable -- a writeHash that is not stable under
 * read(write(s)) causes history.replaceState churn on every render.
 */

export const DEFAULT_STATE = {
  view: "browse",
  q: "",
  mode: "substring",
  eo: null,
  // The agency page, and the index's own filters. `entity` outranks `view` the
  // same way `eo` does -- see the dispatch in App.jsx.
  entity: null,
  // Agencies clicked on the ego graph. The orders list narrows to those naming
  // the agency AND every one of these, so the whole filtered view is a link
  // someone can send -- which is the point of keeping state in the hash at all.
  also: [],
  // Ignore orders naming more agencies than this. Half the orders name one or
  // two; one names 167. Without a cap those few dominate every graph.
  max_agencies: null,
  entity_q: "",
  entity_kind: [],
  entity_min: null,
  // Show only the agencies an order creates, renames, transfers, merges or
  // abolishes. A real boolean, not a string -- see BOOL_KEYS below.
  entity_lineage: null,
  mayor: [],
  source: [],
  text_quality: [],
  picture_tag: [],
  yearMin: null,
  yearMax: null,
  isEmergency: null,
};

const LIST_KEYS = ["mayor", "source", "text_quality", "picture_tag", "entity_kind", "also"];
const INT_KEYS = ["yearMin", "yearMax", "entity_min", "max_agencies"];
// Parsed, never passed through. The fall-through branch below assigns the raw
// string, and a hand-edited `entity_lineage=false` would then be the STRING
// "false" -- which is truthy, so the filter would switch itself on.
const BOOL_KEYS = ["isEmergency", "entity_lineage"];

export function readHash(hash = window.location.hash) {
  // Fresh arrays, not the ones on DEFAULT_STATE: a caller that mutated a
  // returned list would otherwise poison every later read.
  const state = { ...DEFAULT_STATE };
  for (const key of LIST_KEYS) state[key] = [];
  const raw = String(hash || "").replace(/^#/, "");
  if (!raw) return state;

  let params;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return state;
  }

  for (const [key, value] of params.entries()) {
    // Unknown keys are ignored rather than crashing -- hashes get hand-edited
    // and shared, and an old link should degrade, not explode.
    if (!(key in DEFAULT_STATE)) continue;

    if (LIST_KEYS.includes(key)) {
      state[key] = value ? value.split(",").filter(Boolean).sort() : [];
    } else if (INT_KEYS.includes(key)) {
      const n = Number.parseInt(value, 10);
      state[key] = Number.isFinite(n) ? n : null;
    } else if (BOOL_KEYS.includes(key)) {
      state[key] = value === "true" ? true : value === "false" ? false : null;
    } else {
      state[key] = value;
    }
  }
  return state;
}

export function writeHash(state) {
  const params = new URLSearchParams();
  // Fixed key order + sorted list values, so the same logical state always
  // serializes to the same string.
  for (const key of Object.keys(DEFAULT_STATE)) {
    const value = state[key];
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      params.set(key, [...value].sort().join(","));
    } else if (value === DEFAULT_STATE[key]) {
      continue;
    } else {
      params.set(key, String(value));
    }
  }
  const s = params.toString();
  return s ? `#${s}` : "";
}

/**
 * How deep into the app the current history entry is.
 *
 * Every entry this app creates carries its own depth, so a "back" button can
 * tell a step it pushed itself from the entry the visitor arrived on. Anything
 * else -- a fresh load, an entry from before this ran -- reads as 0.
 */
export function historyDepth() {
  const i = window.history.state?.eoNav;
  return Number.isInteger(i) && i >= 0 ? i : 0;
}

/** True when the app itself put a previous state behind this one. */
export function canGoBack() {
  return historyDepth() > 0;
}

/**
 * Apply to the address bar.
 *
 * `mode` is "push" for a move to another page -- an order, an agency, a tab --
 * and "replace" for everything else. Filters, the search box and the graph's
 * own picks overwrite the current entry, so going back returns to the whole
 * state the visitor left, filters included, rather than to a guess at it.
 */
export function pushHash(state, mode = "replace") {
  const next = writeHash(state);
  const url = next || window.location.pathname;
  const depth = historyDepth();
  // A push to the state already showing would add an entry that changes
  // nothing, and back would then appear to do nothing.
  if (mode === "push" && next !== window.location.hash) {
    window.history.pushState({ eoNav: depth + 1 }, "", url);
    return;
  }
  if (next !== window.location.hash || window.history.state?.eoNav !== depth) {
    window.history.replaceState({ eoNav: depth }, "", url);
  }
}

/**
 * Does the app take over this click on a hash link, or does the browser?
 *
 * The app takes a plain left click: it has a whole state to write, and the href
 * carries one key of it. Everything else -- command, control, shift, alt, and
 * any button but the first -- means "open this somewhere else", which is the
 * browser's to do, and a fresh tab starts from the href alone.
 */
export function appHandlesClick(e) {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}
