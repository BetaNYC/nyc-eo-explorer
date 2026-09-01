/**
 * Build SQL for the browse/search view from filter + query state.
 *
 * Every user-supplied value is a bound parameter, never interpolated. That is
 * not paranoia about a static site: mayor names in the pre-1974 era include
 * O'Dwyer, and an apostrophe interpolated into SQL is a syntax error at best.
 */

export const MODES = {
  SUBSTRING: "substring",
  REGEX: "regex",
  BM25: "bm25",
};

/** Facets that are multi-select over a low-cardinality VARCHAR column. */
const MULTI_FACETS = ["mayor", "source", "text_quality", "text_source"];

/**
 * @returns {{where: string[], params: unknown[]}}
 */
export function buildFilters(filters = {}) {
  const where = [];
  const params = [];

  for (const key of MULTI_FACETS) {
    const values = filters[key];
    if (Array.isArray(values) && values.length > 0) {
      where.push(`m.${key} IN (${values.map(() => "?").join(", ")})`);
      params.push(...values);
    }
  }

  if (Number.isFinite(filters.yearMin)) {
    where.push("m.year >= ?");
    params.push(filters.yearMin);
  }
  if (Number.isFinite(filters.yearMax)) {
    where.push("m.year <= ?");
    params.push(filters.yearMax);
  }

  // Tri-state, and the reason it is written this way: `if (filters.isEmergency)`
  // would silently collapse `false` into "any", so filtering for regular orders
  // would return emergency ones too.
  if (filters.isEmergency === true || filters.isEmergency === false) {
    where.push("m.is_emergency = ?");
    params.push(filters.isEmergency);
  }

  // text_quality, not char_count: orders with no recoverable text still carry a
  // 19-character "_No text available_" stub, so char_count is never 0.
  if (filters.hasText === true) where.push("m.text_quality <> 'no-text'");

  return { where, params };
}

/**
 * The FROM/WHERE half of a search, shared by every query shape that means "the
 * orders matching this query and these filters".
 *
 * Extracted rather than duplicated because it is the single definition of what
 * Exact, Regex and Relevance *mean* -- including the parameter ordering, which
 * is positional and silently wrong if a second copy drifts.
 *
 * Substring mode lowercases the needle in JS and scans the precomputed
 * full_text_lc column. Regex mode uses 'is' flags (case-insensitive, dot
 * matches newline). BM25 joins against the FTS index.
 *
 * @returns {{from: string, where: string[], params: unknown[],
 *            scoreSelect: string, orderBy: string, needsText: boolean}}
 */
function searchSource({ mode, parsed, filters }) {
  const { where, params } = buildFilters(filters);
  const needsText = mode === MODES.BM25 || (parsed && !parsed.isEmpty);

  let from = "eo_meta m";
  let scoreSelect = "NULL AS score";
  let orderBy = "m.year DESC, m.eo_id DESC";

  if (needsText && mode === MODES.BM25) {
    const raw = [...parsed.phrases, ...parsed.terms].join(" ");
    from = `(
      SELECT eo_id, fts_main_eo_text.match_bm25(eo_id, ?, conjunctive := 1) AS score
      FROM eo_text
    ) s JOIN eo_meta m USING (eo_id)`;
    // The BM25 parameter binds before any facet parameter, matching clause order.
    params.unshift(raw);
    scoreSelect = "s.score AS score";
    where.push("s.score IS NOT NULL");
    // eo_id breaks score ties so paging is stable.
    orderBy = "s.score DESC, m.eo_id";
  } else if (needsText) {
    from = "eo_meta m JOIN eo_text t USING (eo_id)";
    const col = mode === MODES.REGEX ? "t.full_text" : "t.full_text_lc";

    for (const phrase of [...parsed.phrases, ...parsed.terms]) {
      if (mode === MODES.REGEX) {
        where.push(`regexp_matches(${col}, ?, 'is')`);
      } else {
        where.push(`contains(${col}, ?)`);
      }
      params.push(mode === MODES.REGEX ? phrase : phrase.toLowerCase());
    }
    for (const phrase of parsed.excluded) {
      if (mode === MODES.REGEX) {
        where.push(`NOT regexp_matches(${col}, ?, 'is')`);
      } else {
        where.push(`NOT contains(${col}, ?)`);
      }
      params.push(mode === MODES.REGEX ? phrase : phrase.toLowerCase());
    }
  }

  return { from, where, params, scoreSelect, orderBy, needsText };
}

const whereClause = (where) => (where.length ? `\nWHERE ${where.join("\n  AND ")}` : "");

/** Build the result query for the search view. */
export function buildSearchQuery({ mode, parsed, filters, limit = 50, offset = 0 }) {
  const { from, where, params, scoreSelect, orderBy, needsText } = searchSource({
    mode,
    parsed,
    filters,
  });

  const sql = `SELECT m.eo_id, m.number, m.year, m.date_signed, m.mayor, m.title,
       m.is_emergency, m.text_quality, m.char_count, m.source, ${scoreSelect}
FROM ${from}${whereClause(where)}
ORDER BY ${orderBy}
LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;

  return { sql, params, needsText };
}

/** Count matching the same predicates, for the result header. */
export function buildCountQuery(args) {
  const { sql, params } = buildSearchQuery({ ...args, limit: 1, offset: 0 });
  const body = sql.slice(sql.indexOf("\nFROM "), sql.indexOf("\nORDER BY "));
  return { sql: `SELECT count(*) AS n${body}`, params };
}

/**
 * Facet counts for one column, honoring every OTHER active filter.
 *
 * `pictures: true` restricts the counts to orders that actually have crops, and
 * is what the gallery tab passes. Without it that rail offers mayors whose every
 * order is a 1990s PDF with no clipped regions, each promising a few hundred
 * results and delivering none.
 */
export function buildFacetQuery(column, filters, { pictures = false } = {}) {
  if (!MULTI_FACETS.includes(column) && column !== "year") {
    throw new Error(`not a facetable column: ${column}`);
  }
  const rest = { ...filters };
  delete rest[column];
  const { where, params } = buildFilters(rest);
  // count(DISTINCT), not count(*): an order with four crops is still one order.
  return {
    sql: `SELECT m.${column} AS value, count(${pictures ? "DISTINCT m.eo_id" : "*"}) AS n
FROM eo_meta m${pictures ? "\n  JOIN pictures p USING (eo_id)" : ""}${whereClause(where)}
GROUP BY 1 ORDER BY 2 DESC, 1`,
    params,
  };
}

/**
 * The picture-type predicate.
 *
 * `null` is a real value here -- the upstream heuristic declining to guess --
 * so it travels as the string "none" through the hash and is translated back to
 * `IS NULL` rather than being compared as text. Appended LAST so the parameter
 * order still matches the WHERE order: facets, then text needles, then tags.
 */
function pushTagFilter(where, params, tags) {
  if (!Array.isArray(tags) || tags.length === 0) return;
  const named = tags.filter((t) => t !== "none");
  const parts = [];
  if (named.length > 0) {
    parts.push(`p.tag IN (${named.map(() => "?").join(", ")})`);
    params.push(...named);
  }
  if (tags.includes("none")) parts.push("p.tag IS NULL");
  if (parts.length > 0) where.push(`(${parts.join(" OR ")})`);
}

const PICTURE_COLUMNS = `p.image, p.tag, p.page,
       m.eo_id, m.number, m.year, m.date_signed, m.mayor, m.title, m.source`;

/**
 * Every crop belonging to an order the search matched.
 *
 * The join is the whole feature: the text lives on the order and the pixels
 * live on the page, so "pictures from documents mentioning Robert Moses" is a
 * search over eo_text whose rows are then exploded by `pictures`. An order with
 * no crops drops out; an order with four contributes four tiles.
 */
export function buildPictureQuery({ mode, parsed, filters, limit = 120, offset = 0 }) {
  const { from, where, params, scoreSelect, orderBy, needsText } = searchSource({
    mode,
    parsed,
    filters,
  });
  pushTagFilter(where, params, filters?.pictureTags);

  // Tiles stay grouped by their order and in page order within it, which under
  // Relevance means the ranking survives rather than being shuffled by page.
  const sql = `SELECT ${PICTURE_COLUMNS}, ${scoreSelect}
FROM ${from}
  JOIN pictures p USING (eo_id)${whereClause(where)}
ORDER BY ${orderBy}, p.page, p.image
LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;

  return { sql, params, needsText };
}

/**
 * Both totals for the gallery header, in one pass: how many crops, and how many
 * orders they came from. Reuses the generated body so the counts can never
 * describe a different predicate than the grid does.
 */
export function buildPictureCountQuery(args) {
  const { sql, params } = buildPictureQuery({ ...args, limit: 1, offset: 0 });
  const body = sql.slice(sql.indexOf("\nFROM "), sql.indexOf("\nORDER BY "));
  return {
    sql: `SELECT count(*) AS n_pictures, count(DISTINCT m.eo_id) AS n_orders${body}`,
    params,
  };
}

/**
 * Counts per picture type, honoring the query and every filter EXCEPT the type
 * filter itself -- the same self-excluding rule buildFacetQuery follows, so the
 * number on a chip is what clicking it would yield.
 */
export function buildPictureTagQuery(args) {
  const filters = { ...args.filters };
  delete filters.pictureTags;
  const { sql, params } = buildPictureQuery({ ...args, filters, limit: 1, offset: 0 });
  const body = sql.slice(sql.indexOf("\nFROM "), sql.indexOf("\nORDER BY "));
  return {
    sql: `SELECT coalesce(p.tag, 'none') AS value, count(*) AS n${body}
GROUP BY 1 ORDER BY 1`,
    params,
  };
}

/* ------------------------------------------------------------------------- *
 * Agencies                                                                    *
 *                                                                             *
 * All of these read `eo_entity`, the DISTINCT (order, agency) table built in   *
 * duckdb/store.js, not `entity_mentions` directly. Counting mentions instead   *
 * of orders would weight an agency named nine times in one order as nine       *
 * pieces of evidence when it is one.                                          *
 *                                                                             *
 * The two below that DO read `entity_mentions` both say `NOT in_letterhead`.   *
 * The mayoral stationery names the Office of the Mayor at the head of nearly   *
 * every order; showing that beside the text would put the office in the panel  *
 * of 2,438 orders it has nothing to do with. `eo_entity` is already narrowed   *
 * the same way -- see duckdb/store.js.                                        *
 * ------------------------------------------------------------------------- */

/** How the ego graph decides which agencies matter. */
export const RANKINGS = {
  /** Orders naming both. Honest, and no longer skewed by the letterhead. */
  SHARED: "shared",
  /** The share of the two agencies' combined orders that name both. */
  AFFINITY: "affinity",
};

/**
 * A pair has to share at least this many orders before it is ranked at all.
 *
 * ONE, so the graph is what the corpus says: every co-mention, drawn. It used to
 * be two, on the argument that one shared order cannot tell a relationship from
 * a coincidence. True of one PAIR, and wrong as a floor on the whole graph:
 * 1,503 of the 2,338 agencies are named in exactly one order, so their partners
 * can never share two, and a floor of two emptied 1,614 of the 2,338 pages
 * outright. Not a finding about the corpus -- an artefact of the constant.
 *
 * The filter that does the real work is the cap on how many agencies one order
 * may name (:func:`agencyCap`), which is under the reader's hand beside the
 * graph. That one is about the ORDERS, which is where the noise actually is: a
 * delegation of authority naming 167 agencies manufactures 13,861 pairs.
 */
export const MIN_SHARED = 1;

/**
 * Names seen in fewer than this many orders are hidden from the index by default.
 *
 * The same cutoff the scan upstream uses to decide what a person should review.
 * Pass two proposes 2,167 names and most are seen once -- a phrase shaped like
 * an agency name that is not one. They are kept in the data and the control that
 * hides them can be turned down, so a one-off body stays findable.
 */
export const DEFAULT_MIN_ORDERS = 3;

/**
 * The agencies named in one order, in the order they are first named.
 *
 * Document order, not by frequency: this panel sits beside the text, and reading
 * it top to bottom should track reading the order top to bottom.
 */
export function buildEntitiesForEoQuery(eoId) {
  return {
    sql: `
      SELECT e.entity_id, e.display_name, e.kind, e.short_name,
             count(*) AS mentions,
             bool_or(m.ambiguous) AS ambiguous,
             min(m.start) AS first_at
      FROM entity_mentions m
      JOIN entities e USING (entity_id)
      WHERE m.eo_id = ? AND NOT m.in_letterhead
      GROUP BY 1, 2, 3, 4
      ORDER BY first_at`,
    params: [eoId],
  };
}

/** Where each mention sits in the order's text, so the raw view can mark them. */
export function buildMentionSpansQuery(eoId) {
  return {
    sql: `
      SELECT DISTINCT m.start, m.end, m.entity_id, e.display_name, e.kind
      FROM entity_mentions m
      JOIN entities e USING (entity_id)
      WHERE m.eo_id = ? AND NOT m.in_letterhead
      ORDER BY m.start, m.end`,
    params: [eoId],
  };
}

/**
 * Display names for a set of agency ids.
 *
 * The filter chips need these, and they cannot come off the graph: capping the
 * order size rebuilds the ring, so an agency already chosen can drop off it and
 * the chip would fall back to printing a raw slug.
 */
export function buildEntityNamesQuery(entityIds) {
  const ids = [...new Set(entityIds ?? [])].filter(Boolean);
  if (ids.length === 0) return null;
  return {
    sql: `SELECT entity_id, display_name, kind FROM entities
          WHERE entity_id IN (${ids.map(() => "?").join(", ")})`,
    params: ids,
  };
}

/** One agency's own record. */
export function buildEntityQuery(entityId) {
  return { sql: `SELECT * FROM entities WHERE entity_id = ?`, params: [entityId] };
}

function entityIndexSource({ q, kinds, minOrders, hasLineage }) {
  const where = ["e.display_name IS NOT NULL"];
  const params = [];

  if (q) {
    // Matches an alternate spelling too, so searching "DoITT" finds the
    // department whose page is titled with the name written out in full.
    where.push(
      `(lower(e.display_name) LIKE ? OR lower(coalesce(e.short_name, '')) LIKE ?
        OR EXISTS (SELECT 1 FROM unnest(e.other_names) AS t(alt) WHERE lower(alt) LIKE ?))`
    );
    const needle = `%${q.toLowerCase()}%`;
    params.push(needle, needle, needle);
  }
  if (Array.isArray(kinds) && kinds.length > 0) {
    where.push(`e.kind IN (${kinds.map(() => "?").join(", ")})`);
    params.push(...kinds);
  }
  if (Number.isFinite(minOrders) && minOrders > 1) {
    where.push("e.eo_count >= ?");
    params.push(minOrders);
  }
  // A predicate and not a join. `event_count` is folded onto the entity row by
  // the build precisely so that asking "does this agency have any lineage" costs
  // nothing -- the index and its count both run this on every keystroke.
  if (hasLineage) where.push("e.event_count > 0");
  return { where, params };
}

/** The agency index, most-cited first. */
export function buildEntityIndexQuery({
  q,
  kinds,
  minOrders,
  hasLineage,
  limit = 50,
  offset = 0,
}) {
  const { where, params } = entityIndexSource({ q, kinds, minOrders, hasLineage });
  return {
    sql: `
      SELECT e.entity_id, e.display_name, e.kind, e.short_name, e.classification,
             e.eo_count, e.mention_count, e.first_year, e.last_year, e.event_count
      FROM entities e${whereClause(where)}
      ORDER BY e.eo_count DESC, e.display_name
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    params,
  };
}

export function buildEntityIndexCountQuery({ q, kinds, minOrders, hasLineage }) {
  const { where, params } = entityIndexSource({ q, kinds, minOrders, hasLineage });
  return { sql: `SELECT count(*) AS n FROM entities e${whereClause(where)}`, params };
}

/**
 * Every reorganization event that names one agency, oldest first.
 *
 * Either SIDE counts: the agency a body was renamed from is as much a part of
 * its history as the one it was renamed to. The `parent` role is NOT a side, so
 * an agency that dozens of bodies were established INSIDE does not collect dozens
 * of events it never had. Containment is its own question and
 * `buildEntityContainsQuery` answers it.
 *
 * The counterpart's display name and kind are joined here rather than looked up
 * by the view. Both sides of an event resolve against the same table the page
 * itself came from, and a second round trip per row to name a box would be the
 * one thing standing between the panel and its first paint.
 *
 * `d.year` is NULL for no event, because every event carries an eo_id that the
 * build has already checked against the corpus -- but the join stays a LEFT one
 * so a future mismatch loses a date rather than a whole row.
 */
export function buildEntityEventsQuery(entityId) {
  return {
    sql: `
      SELECT v.eo_id, v.event_seq, v.kind, v.verb, v.text,
             v.from_id, v.from_name, v.to_id, v.to_name, v.parent_name,
             f.display_name AS from_display_name, f.kind AS from_entity_kind,
             t.display_name AS to_display_name,   t.kind AS to_entity_kind,
             d.year, d.date_signed, d.mayor, d.title
      FROM agency_events v
      LEFT JOIN entities f ON f.entity_id = v.from_id
      LEFT JOIN entities t ON t.entity_id = v.to_id
      LEFT JOIN eo_meta  d ON d.eo_id     = v.eo_id
      WHERE v.from_id = ? OR v.to_id = ?
      ORDER BY d.year, d.date_signed NULLS LAST, v.eo_id, v.event_seq`,
    params: [entityId, entityId],
  };
}

/**
 * The bodies an order placed INSIDE one agency, oldest first.
 *
 * "The Office of Cyber Command ..., the Office of Data Analytics ... and the
 * Office of Information Privacy ... shall be continued and established within the
 * Office of Technology and Innovation" (2022-EO-003 § 3) is three offices moving
 * into OTI. Read from OTI's own page that is the most useful thing the order says,
 * and the lineage query cannot show it: OTI is on neither side of those three
 * events.
 *
 * So this is a SEPARATE query, and containment stays out of the lineage panel and
 * out of `event_count`. An office is not renamed into the thing that contains it,
 * and a chain that mixed the two would read as though it were.
 *
 * Only rows whose `parent_id` resolved to a page are returned. A parent named but
 * unmatched is still printed on the contained body's own row, where the name alone
 * is enough.
 */
export function buildEntityContainsQuery(entityId) {
  return {
    sql: `
      SELECT v.eo_id, v.event_seq, v.kind, v.verb, v.text,
             v.to_id, v.to_name,
             t.display_name AS to_display_name, t.kind AS to_entity_kind,
             d.year, d.date_signed, d.mayor, d.title
      FROM agency_events v
      LEFT JOIN entities t ON t.entity_id = v.to_id
      LEFT JOIN eo_meta  d ON d.eo_id     = v.eo_id
      WHERE v.parent_id = ?
      ORDER BY d.year, d.date_signed NULLS LAST, v.eo_id, v.event_seq`,
    params: [entityId],
  };
}

/**
 * The orders naming EVERY one of these agencies, as a CTE named `sel`.
 *
 * The agency the page is about is always in the set -- the page is its history,
 * and an order that does not name it does not belong in the list whatever else
 * it names. Anything clicked on the graph narrows from there.
 *
 * `count(*) = n` is the intersection, and it is correct only because `eo_entity`
 * holds ONE row per (order, agency) pair. Against `entity_mentions`, an agency
 * named three times in one order would count as three and an order naming one of
 * three chosen agencies would pass a test meant for all three.
 *
 * Ids are deduplicated for the same reason: the same id twice would raise the
 * required count without raising what any order can reach, and the result would
 * always be empty.
 */
function intersectionSource(entityId, alsoIds = [], maxAgencies = null) {
  const ids = [...new Set([entityId, ...(alsoIds ?? [])])].filter(Boolean);
  const cap = agencyCap(maxAgencies);
  return {
    cte: `sel AS (
      SELECT e.eo_id FROM eo_entity e
      JOIN eo_agencies a ON a.eo_id = e.eo_id AND a.agencies <= ${cap}
      WHERE e.entity_id IN (${ids.map(() => "?").join(", ")})
      GROUP BY e.eo_id
      HAVING count(*) = ${Number(ids.length)}
    )`,
    params: ids,
  };
}

/**
 * How many agencies an order may name and still be counted. No cap by default.
 *
 * The corpus needs this. Half the orders name one or two agencies, but the tail
 * runs to 167 in a single order -- delegations of authority that list every
 * agency in the city. One such order alone manufactures 13,861 agency pairs, so
 * a handful of them dominate every graph and make co-mention look like a
 * property of the corpus rather than of the orders.
 *
 * Inlined into the SQL rather than bound, so it must be a number and never a
 * string from a URL. NO_CAP is above the largest order in the corpus by a wide
 * margin, which lets one query shape serve both the capped and uncapped case.
 */
export const NO_CAP = 100000;

export function agencyCap(maxAgencies) {
  const n = Number(maxAgencies);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : NO_CAP;
}

/**
 * Every order naming one agency, oldest first.
 *
 * Ordered by date and NOT by year, so the sequence within a year is right too.
 * `date_signed` is NULL for a handful of orders whose date could not be read off
 * the scan; those sort last within their year rather than vanishing.
 */
export function buildEntityOrdersQuery(entityId, alsoIds = [], maxAgencies = null) {
  const sel = intersectionSource(entityId, alsoIds, maxAgencies);
  return {
    sql: `
      WITH ${sel.cte}
      SELECT m.eo_id, m.year, m.date_signed, m.mayor, m.title, m.is_emergency,
             ent.n AS mentions
      FROM sel
      JOIN eo_entity ent ON ent.eo_id = sel.eo_id AND ent.entity_id = ?
      JOIN eo_meta m ON m.eo_id = sel.eo_id
      ORDER BY m.year, m.date_signed NULLS LAST, m.eo_id`,
    params: [...sel.params, entityId],
  };
}

/**
 * The agencies named alongside one agency, and how strongly.
 *
 * Two measures, because the obvious one is nearly useless on its own. "Office of
 * the Mayor" is named in 2,449 of the 3,131 orders that name anything -- it is
 * the letterhead. Rank by shared orders and it tops every agency's graph, which
 * says nothing about any of them.
 *
 * `affinity` is the Jaccard index: of every order that names EITHER agency, the
 * share that names both. It is the default, and it was chosen over lift after
 * both were measured against this corpus. Lift divides out the letterhead but
 * then breaks the other way -- a body named in 4 orders that happen to be 4 of
 * the Board of Estimate's 142 scores higher than the Comptroller, which shares
 * 63 of them. The pattern pass proposes thousands of such near-duplicate
 * fragments, so lift filled the graph with them and buried every real
 * relationship.
 *
 * Affinity has a large denominator at both ends, so it suppresses both failure
 * modes at once: the letterhead (huge `eo_count`) and the fragment (tiny
 * `shared`). Ranked this way the Board of Estimate's neighbours come out as the
 * Comptroller, the City Council, the Board of Education and the Bureau of the
 * Budget -- which is who it actually made budgets with.
 *
 * Both measures are returned, but switching between them RE-QUERIES rather than
 * re-sorting what is already here: the LIMIT is applied after the ORDER BY, so
 * the top 24 by affinity and the top 24 by shared orders are different sets, not
 * the same set in a different order.
 */
export function buildCooccurrenceQuery(
  entityId,
  { limit = 24, minShared = MIN_SHARED, ranking = RANKINGS.AFFINITY, maxAgencies = null } = {}
) {
  const orderBy =
    ranking === RANKINGS.SHARED
      ? "shared DESC, affinity DESC, e.display_name"
      : "affinity DESC, shared DESC, e.display_name";
  const cap = agencyCap(maxAgencies);
  return {
    sql: `
      WITH ce AS (
             SELECT e.eo_id, e.entity_id
             FROM eo_entity e
             JOIN eo_agencies a ON a.eo_id = e.eo_id AND a.agencies <= ${cap}
           ),
           mine AS (SELECT eo_id FROM ce WHERE entity_id = ?),
           me AS (SELECT count(*) AS n FROM mine),
           -- Each agency's order count WITHIN the cap. Deliberately not
           -- entities.eo_count: that counts the whole corpus, and using it as
           -- the denominator under a cap would divide a capped numerator by an
           -- uncapped total and quietly shrink every affinity on the page.
           theirs AS (SELECT entity_id, count(*) AS n FROM ce GROUP BY 1)
      SELECT o.entity_id, e.display_name, e.kind, t.n AS eo_count,
             count(*) AS shared,
             count(*)::DOUBLE
               / ((SELECT n FROM me) + t.n - count(*)) AS affinity
      FROM ce o
      JOIN mine USING (eo_id)
      JOIN entities e ON e.entity_id = o.entity_id
      JOIN theirs t ON t.entity_id = o.entity_id
      WHERE o.entity_id <> ?
      GROUP BY 1, 2, 3, 4
      HAVING count(*) >= ?
      ORDER BY ${orderBy}
      LIMIT ${Number(limit)}`,
    params: [entityId, entityId, minShared],
  };
}

/**
 * How often the agencies on the ring are named together, ignoring the center.
 *
 * `a.entity_id < b.entity_id` so each pair is counted once and drawn once.
 *
 * The floor does NOT keep the ring from filling in solid, whatever it is set to.
 * Measured on this corpus: the Board of Estimate's ring draws 176 of its 276
 * possible chords at a floor of 1 and 157 at a floor of 2; the Office of the
 * Mayor's draws 263 and 257. A hub's ring is dense because its neighbours all
 * know each other, and no floor worth having thins that out. If the smear needs
 * fixing, the ring SELECTION is the place, not this number.
 */
export function buildCooccurrenceEdgesQuery(entityIds, { minShared = MIN_SHARED } = {}) {
  if (!Array.isArray(entityIds) || entityIds.length < 2) return null;
  const holes = entityIds.map(() => "?").join(", ");
  return {
    sql: `
      SELECT a.entity_id AS src, b.entity_id AS dst, count(*) AS shared
      FROM eo_entity a
      JOIN eo_entity b USING (eo_id)
      WHERE a.entity_id IN (${holes})
        AND b.entity_id IN (${holes})
        AND a.entity_id < b.entity_id
      GROUP BY 1, 2
      HAVING count(*) >= ?
      ORDER BY shared DESC, src, dst`,
    params: [...entityIds, ...entityIds, minShared],
  };
}

/** Orders per year for one agency — the lineage strip. */
export function buildEntityYearsQuery(entityId, alsoIds = [], maxAgencies = null) {
  const sel = intersectionSource(entityId, alsoIds, maxAgencies);
  return {
    sql: `
      WITH ${sel.cte}
      SELECT m.year, count(*) AS n, min(m.mayor) AS mayor
      FROM sel
      JOIN eo_meta m ON m.eo_id = sel.eo_id
      GROUP BY 1
      ORDER BY 1`,
    params: sel.params,
  };
}

/**
 * Which agencies on the ring could still be added without emptying the result.
 *
 * The graph is a query builder, so it has to say what the next click would do
 * BEFORE the click. An agency that shares no order with everything already
 * chosen leads to an empty list, and offering it as a live control that returns
 * nothing is worse than greying it out.
 *
 * Returns a count per agency, over the orders currently selected. Anything the
 * result does not mention shares nothing, so an absent row means zero -- the
 * caller treats missing as ineligible rather than this query padding it out with
 * a row per ring member.
 */
export function buildRingEligibilityQuery(entityId, alsoIds, ringIds, maxAgencies = null) {
  const ring = [...new Set(ringIds ?? [])].filter(Boolean);
  if (ring.length === 0) return null;
  const sel = intersectionSource(entityId, alsoIds, maxAgencies);
  return {
    sql: `
      WITH ${sel.cte}
      SELECT e.entity_id, count(*) AS n
      FROM eo_entity e
      JOIN sel ON sel.eo_id = e.eo_id
      WHERE e.entity_id IN (${ring.map(() => "?").join(", ")})
      GROUP BY 1`,
    params: [...sel.params, ...ring],
  };
}

/**
 * The last column of the agencies-per-order histogram is a tail bucket.
 *
 * Everything at or above this many agencies is one bar. Past 20 the counts are
 * 1s and 2s scattered out to a single order that names 167, and 147 near-empty
 * columns would hide the shape the chart exists to show.
 */
export const AGENCY_TAIL = 20;

/**
 * How many orders name 0 agencies, 1 agency, 2, and so on.
 *
 * LEFT JOIN from eo_meta, NOT a plain GROUP BY over eo_agencies. An order that
 * names no agency has no row in eo_agencies at all, so grouping that table alone
 * silently drops the 0 column -- the one column that says how often the scan
 * found nothing. Reporting a distribution with its zero cut off is the same
 * class of mistake as reporting 100% text coverage.
 *
 * `agencies` is already a count of DISTINCT entities per order (eo_agencies is
 * built off eo_entity, which groups by eo_id and entity_id), so an order that
 * names one agency nine times counts as 1 here.
 */
export function buildAgencyHistogramQuery(tail = AGENCY_TAIL) {
  return `
    SELECT least(coalesce(a.agencies, 0), ${Number(tail)}) AS bucket, count(*) AS n
    FROM eo_meta m
    LEFT JOIN eo_agencies a ON a.eo_id = m.eo_id
    GROUP BY 1
    ORDER BY 1`;
}

/**
 * The numbers the histogram's caption quotes.
 *
 * `none_no_text` is the honest half of the 0 column: an order with no
 * recoverable text cannot name an agency, so its 0 is a gap in the data rather
 * than a fact about the order. The caption has to be able to say so.
 */
export function buildAgencyCountStatsQuery() {
  return `
    SELECT median(coalesce(a.agencies, 0)) AS median,
           max(coalesce(a.agencies, 0))    AS most,
           count(*) FILTER (coalesce(a.agencies, 0) = 0) AS none,
           count(*) FILTER (coalesce(a.agencies, 0) = 0
                            AND m.text_quality = 'no-text')            AS none_no_text
    FROM eo_meta m
    LEFT JOIN eo_agencies a ON a.eo_id = m.eo_id`;
}
