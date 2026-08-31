/**
 * Turn the upstream `corpus/mentions.json` into the two flat tables the app queries.
 *
 * The scan upstream runs two passes and they do NOT produce the same shape:
 *
 *   pass one  `mentions[]`  a name from the agency registry, carrying `agency_id`
 *   pass two  `proposed[]`  a phrase SHAPED like an agency name, carrying only text
 *
 * The app has to show both. The registry holds agencies that exist today and
 * marks all 317 of them active, so a body that was shut down -- the Board of
 * Estimate, the Bureau of the Budget, DoITT -- can appear in pass two and
 * nowhere else. Those are most of the history. Dropping them to keep the table
 * clean would delete exactly what an agency page is for.
 *
 * So the two are given one key space and a `kind` that says which pass found
 * them, and the interface labels every row. A reader is never left guessing
 * whether a name was confirmed against a register or matched by a pattern.
 *
 * Pure functions, no filesystem, no DuckDB -- so the id scheme and the merging
 * rules can be tested directly.
 */

/**
 * Marks an id minted here rather than taken from the registry.
 *
 * Checked against the real registry at build time (`assertNoPrefixCollision`),
 * because the whole scheme rests on the two never colliding: a registry slug is
 * derived from an agency's name, and one starting "x-" would silently take over
 * a proposed entity's page.
 */
export const PROPOSED_PREFIX = "x-";

export const KIND_REGISTRY = "registry";
export const KIND_PROPOSED = "proposed";

/**
 * Reduce a name to a comparison key, matching `lineage/normalize.py::normalize_name`.
 *
 * Keep the two in step. If they drift, the same agency gets one id here and a
 * different one upstream, and the join stops meaning anything.
 *
 * Drops accents, lowercases, removes a leading "the"/"a"/"an" so "the Office of
 * X" keys the same as "Office of X", and turns every other run of punctuation or
 * whitespace into a single space.
 */
export function normalizeName(name) {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/^\s*(the|a|an)\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The id for a name pass two proposed. Empty name -> null, never a bare prefix. */
export function proposedEntityId(name) {
  const key = normalizeName(name).replace(/ /g, "-");
  return key ? PROPOSED_PREFIX + key : null;
}

/**
 * Fail the build if any registry slug could be mistaken for a minted one.
 *
 * Not defensive noise: it is the single assumption the id scheme rests on, it is
 * cheap to check, and it can only ever be broken by a rename upstream that
 * nobody here would otherwise notice.
 */
export function assertNoPrefixCollision(agencies) {
  const clashes = agencies
    .map((a) => a.id)
    .filter((id) => typeof id === "string" && id.startsWith(PROPOSED_PREFIX));
  if (clashes.length > 0) {
    throw new Error(
      `registry ids must not start with "${PROPOSED_PREFIX}" -- that prefix marks a ` +
        `proposed name, and these would collide: ${clashes.join(", ")}`
    );
  }
}

/**
 * One row per (mention, entity it names).
 *
 * A pass-one name that could belong to two agencies pins down neither. Upstream
 * says so honestly -- `agency_id: null`, `pins_down: "several-agencies"` -- and
 * this keeps that honesty by emitting a row for EVERY candidate and flagging it
 * `ambiguous`. The name then shows on both agencies' pages, marked. Picking a
 * winner here would invent a fact the scan refused to invent. Four names in the
 * whole corpus are affected.
 *
 * `start`/`end` index into the order's `full_text`, and upstream proves
 * `full_text[start:end] === text` for all 23,504 finds. That is what lets the
 * detail view highlight a mention in the raw text rather than search for it again.
 *
 * `in_letterhead` comes straight from upstream and is carried, not acted on
 * here. Nearly every order opens with `OFFICE OF THE MAYOR` on its stationery,
 * and the scan marks those 2,560 finds rather than deleting them. This table
 * stays the complete record; the queries that COUNT decide what to leave out --
 * see `entityRows` below and `eo_entity` in src/duckdb/store.js. A pass-two name
 * is never marked, because upstream only judges the mayoral masthead.
 */
export function mentionRows(payload) {
  const rows = [];

  for (const m of payload.mentions ?? []) {
    const ids = m.agency_id ? [m.agency_id] : (m.agency_ids ?? []);
    for (const entityId of ids) {
      rows.push({
        eo_id: m.eo_id,
        entity_id: entityId,
        kind: KIND_REGISTRY,
        ambiguous: ids.length > 1,
        start: m.start,
        end: m.end,
        text: m.text,
        in_letterhead: m.in_letterhead === true,
      });
    }
  }

  for (const p of payload.proposed ?? []) {
    const entityId = proposedEntityId(p.name);
    if (!entityId) continue;
    rows.push({
      eo_id: p.eo_id,
      entity_id: entityId,
      kind: KIND_PROPOSED,
      ambiguous: false,
      start: p.start,
      end: p.end,
      text: p.text,
      in_letterhead: false,
    });
  }

  rows.sort(
    (a, b) =>
      a.eo_id.localeCompare(b.eo_id) ||
      a.start - b.start ||
      a.entity_id.localeCompare(b.entity_id)
  );
  return rows;
}

/**
 * Pick the spelling to show, out of every spelling that keyed to one id.
 *
 * Upstream groups proposed names by their exact string, so "Legislative Program"
 * (30 finds) and "LEGISLATIVE PROGRAM" (22) arrive as two separate names. They
 * are one body. Normalizing merges them, and this decides which of the two the
 * page is titled with: the one written most often, and alphabetically first on a
 * tie so a rebuild cannot flip it.
 *
 * The spellings not chosen are not thrown away -- they become the entity's
 * `other_names`, mirroring what the registry carries for a confirmed agency.
 */
export function pickDisplayName(counts) {
  const entries = [...counts.entries()];
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    display_name: entries[0]?.[0] ?? null,
    other_names: entries.slice(1).map(([name]) => name),
  };
}

/** The registry columns every entity row carries, NULL for a proposed one. */
const REGISTRY_FIELDS = [
  "name",
  "short_name",
  "government_level",
  "classification",
  "parent_id",
  "primary_domain",
  "status",
  "founding_date",
  "dissolution_date",
  "description",
  "description_source_url",
];

const emptyRegistryFields = () => Object.fromEntries(REGISTRY_FIELDS.map((f) => [f, null]));

/**
 * One row per entity: what to call it, where it came from, and how much of the
 * corpus it touches.
 *
 * The counts are folded in here rather than left to a join at query time so the
 * index and the header paint from a single ~900-row table. `first_year` and
 * `last_year` need the corpus, so they are passed in as a map -- this module
 * never reads a file.
 *
 * **Letterhead is counted separately.** The mayoral stationery names the Office
 * of the Mayor at the head of 2,438 orders, so counting it would say the office
 * appears in three quarters of the corpus, and would stretch its years to the
 * whole span. Every number a reader reads as "how much of the corpus names this"
 * -- `eo_count`, `mention_count`, `first_year`, `last_year`, and which spelling
 * titles the page -- is taken from the body only. `letterhead_count` carries the
 * rest, so the total is still recoverable and nothing is hidden.
 */
export function entityRows(payload, rows, yearByEoId) {
  const agencyById = new Map((payload.agencies ?? []).map((a) => [a.id, a]));

  const acc = new Map();
  for (const r of rows) {
    let e = acc.get(r.entity_id);
    if (!e) {
      e = {
        entity_id: r.entity_id,
        kind: r.kind,
        spellings: new Map(),
        orders: new Set(),
        mention_count: 0,
        letterhead_count: 0,
        first_year: null,
        last_year: null,
      };
      acc.set(r.entity_id, e);
    }
    if (r.in_letterhead) {
      e.letterhead_count += 1;
      continue;
    }
    e.mention_count += 1;
    e.orders.add(r.eo_id);
    const spelling = collapseSpaces(r.text);
    e.spellings.set(spelling, (e.spellings.get(spelling) ?? 0) + 1);

    const year = yearByEoId.get(r.eo_id);
    if (typeof year === "number") {
      if (e.first_year === null || year < e.first_year) e.first_year = year;
      if (e.last_year === null || year > e.last_year) e.last_year = year;
    }
  }

  const out = [];
  for (const e of acc.values()) {
    const agency = agencyById.get(e.entity_id);
    // A confirmed agency is titled by the registry's official name, not by
    // whichever spelling the orders happened to use most: "DOC" is found 2,117
    // times and "Department of Correction" 490, and the page belongs under the
    // department's actual name.
    const picked = pickDisplayName(e.spellings);
    const display = agency?.name ?? picked.display_name;
    const others = agency ? (agency.other_names ?? []) : picked.other_names;
    // A registry agency is titled by the registry either way. A PROPOSED name is
    // titled by its spellings, and upstream never marks one, so this cannot bite
    // today -- but a widened rule upstream would leave the page with no title at
    // all, which is the kind of thing that shows up as a blank in production.
    if (display === null) {
      throw new Error(
        `${e.entity_id} has ${e.letterhead_count} finds and all of them are ` +
          `letterhead, so there is no spelling to title it with`
      );
    }

    out.push({
      entity_id: e.entity_id,
      kind: e.kind,
      display_name: display,
      other_names: others,
      ...emptyRegistryFields(),
      ...(agency ? pick(agency, REGISTRY_FIELDS) : {}),
      eo_count: e.orders.size,
      mention_count: e.mention_count,
      letterhead_count: e.letterhead_count,
      first_year: e.first_year,
      last_year: e.last_year,
    });
  }

  out.sort((a, b) => a.entity_id.localeCompare(b.entity_id));
  return out;
}

const pick = (obj, fields) =>
  Object.fromEntries(fields.map((f) => [f, obj[f] === undefined ? null : obj[f]]));

/**
 * Every run of whitespace to one space.
 *
 * A found name wraps across lines constantly -- pulling text out of a PDF makes
 * "Cyber\nCommand" the ordinary case, not the exception -- so the raw `text` is
 * unusable as a label even though it is exactly right as a record of what the
 * page says.
 */
export function collapseSpaces(text) {
  return String(text ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}
