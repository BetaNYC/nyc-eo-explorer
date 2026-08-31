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
    } else if (key === "isEmergency") {
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

/** Apply to the address bar without adding a history entry, and only if changed. */
export function pushHash(state) {
  const next = writeHash(state);
  if (next !== window.location.hash) {
    window.history.replaceState(null, "", next || window.location.pathname);
  }
}
