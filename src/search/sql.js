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
