import { describe, expect, it } from "vitest";

import { parseQuery } from "../src/search/parseQuery.js";
import {
  MODES,
  buildFacetQuery,
  buildFilters,
  buildPictureCountQuery,
  buildPictureQuery,
  buildPictureTagQuery,
  buildSearchQuery,
} from "../src/search/sql.js";

const noQuery = parseQuery("");

describe("buildFilters", () => {
  it("produces no clauses at all for empty state", () => {
    // Guards against the `WHERE 1=1 AND ...` pattern, which works but makes
    // every generated query harder to read and to test.
    expect(buildFilters({})).toEqual({ where: [], params: [] });
  });

  it("expands a multi-select into one IN with matching arity", () => {
    const { where, params } = buildFilters({ mayor: ["Koch", "Dinkins", "Beame"] });
    expect(where).toEqual(["m.mayor IN (?, ?, ?)"]);
    expect(params).toEqual(["Koch", "Dinkins", "Beame"]);
  });

  it("treats is_emergency as tri-state", () => {
    // The bug this pins: `if (filters.isEmergency)` would drop the `false`
    // case, so "regular orders only" would silently return emergency ones too.
    expect(buildFilters({ isEmergency: false }).params).toEqual([false]);
    expect(buildFilters({ isEmergency: true }).params).toEqual([true]);
    expect(buildFilters({ isEmergency: null }).where).toEqual([]);
  });

  it("ignores non-numeric year bounds", () => {
    expect(buildFilters({ yearMin: undefined, yearMax: NaN }).where).toEqual([]);
    expect(buildFilters({ yearMin: 1978 }).where).toEqual(["m.year >= ?"]);
  });
});

describe("buildSearchQuery", () => {
  it("never interpolates a user value into the SQL text", () => {
    // O'Dwyer is a real mayor in the pre-1974 era; an interpolated apostrophe
    // is a syntax error at best.
    const { sql, params } = buildSearchQuery({
      mode: MODES.SUBSTRING,
      parsed: parseQuery('"the commissioner\'s office"'),
      filters: { mayor: ["O'Dwyer"] },
    });
    expect(sql).not.toContain("O'Dwyer");
    expect(sql).not.toContain("commissioner");
    expect(params).toContain("O'Dwyer");
  });

  it("does not join the text table when there is no query", () => {
    const { sql, needsText } = buildSearchQuery({
      mode: MODES.SUBSTRING,
      parsed: noQuery,
      filters: {},
    });
    expect(needsText).toBe(false);
    expect(sql).not.toContain("eo_text");
  });

  it("lowercases substring needles to match the precomputed column", () => {
    const { sql, params } = buildSearchQuery({
      mode: MODES.SUBSTRING,
      parsed: parseQuery("Commissioner"),
      filters: {},
    });
    expect(sql).toContain("contains(t.full_text_lc, ?)");
    expect(params).toEqual(["commissioner"]);
  });

  it("uses the raw column and case-insensitive flags for regex", () => {
    const { sql, params } = buildSearchQuery({
      mode: MODES.REGEX,
      parsed: parseQuery("admin[il1]strat"),
      filters: {},
    });
    expect(sql).toContain("regexp_matches(t.full_text, ?, 'is')");
    expect(params).toEqual(["admin[il1]strat"]);
  });

  it("negates excluded terms", () => {
    const { sql } = buildSearchQuery({
      mode: MODES.SUBSTRING,
      parsed: parseQuery("tenants -emergency"),
      filters: {},
    });
    expect(sql).toContain("NOT contains(t.full_text_lc, ?)");
  });

  it("binds the bm25 parameter before any facet parameter", () => {
    // Clause order and parameter order must agree or every filter silently
    // shifts by one.
    const { sql, params } = buildSearchQuery({
      mode: MODES.BM25,
      parsed: parseQuery("procurement"),
      filters: { mayor: ["Koch"] },
    });
    expect(sql).toContain("match_bm25");
    expect(params[0]).toBe("procurement");
    expect(params[1]).toBe("Koch");
  });

  it("breaks score ties on eo_id so paging is stable", () => {
    const { sql } = buildSearchQuery({
      mode: MODES.BM25,
      parsed: parseQuery("x"),
      filters: {},
    });
    expect(sql).toContain("ORDER BY s.score DESC, m.eo_id");
  });
});

describe("buildFacetQuery", () => {
  it("excludes the facet's own column from its predicates", () => {
    // Otherwise selecting "Koch" would make every other mayor's count zero.
    const { sql, params } = buildFacetQuery("mayor", {
      mayor: ["Koch"],
      text_quality: ["clean"],
    });
    expect(params).toEqual(["clean"]);
    expect(sql).not.toContain("m.mayor IN");
  });

  it("refuses a column that is not facetable", () => {
    expect(() => buildFacetQuery("full_text", {})).toThrow();
  });

  it("counts orders, not crops, when restricted to picture-bearing ones", () => {
    // count(*) over the join would multiply a mayor by however many crops each
    // of their orders has -- 2,137 crops across 921 orders, so roughly double.
    const { sql } = buildFacetQuery("mayor", {}, { pictures: true });
    expect(sql).toContain("JOIN pictures p USING (eo_id)");
    expect(sql).toContain("count(DISTINCT m.eo_id)");
  });

  it("leaves the plain facet query untouched", () => {
    expect(buildFacetQuery("mayor", {}).sql).not.toContain("pictures");
  });
});

describe("buildPictureQuery", () => {
  it("joins the crops onto the orders a search matched", () => {
    const { sql, params } = buildPictureQuery({
      mode: MODES.SUBSTRING,
      parsed: parseQuery("robert moses"),
      filters: {},
    });
    expect(sql).toContain("JOIN pictures p USING (eo_id)");
    expect(sql).toContain("contains(t.full_text_lc, ?)");
    expect(params).toEqual(["robert", "moses"]);
  });

  it("browses every crop without joining the text table", () => {
    // The gallery is usable before the ~1.7 MB of text has been fetched.
    const { sql, needsText } = buildPictureQuery({
      mode: MODES.SUBSTRING,
      parsed: noQuery,
      filters: {},
    });
    expect(needsText).toBe(false);
    expect(sql).not.toContain("eo_text");
    expect(sql).toContain("JOIN pictures p USING (eo_id)");
  });

  it("orders crops within their order by page, after the search's own order", () => {
    const { sql } = buildPictureQuery({
      mode: MODES.SUBSTRING,
      parsed: noQuery,
      filters: {},
    });
    expect(sql).toContain("ORDER BY m.year DESC, m.eo_id DESC, p.page, p.image");
  });

  it("keeps the bm25 parameter first even with a tag filter appended last", () => {
    // Three parameter sources now feed one WHERE. Their order is positional and
    // a swap silently searches for the wrong thing rather than erroring.
    const { params } = buildPictureQuery({
      mode: MODES.BM25,
      parsed: parseQuery("procurement"),
      filters: { mayor: ["Koch"], pictureTags: ["sig"] },
    });
    expect(params).toEqual(["procurement", "Koch", "sig"]);
  });

  it("binds the tag filter after the facets and the needles", () => {
    const { params } = buildPictureQuery({
      mode: MODES.SUBSTRING,
      parsed: parseQuery("moses"),
      filters: { mayor: ["Wagner"], pictureTags: ["seal"] },
    });
    expect(params).toEqual(["Wagner", "moses", "seal"]);
  });

  it("filters to named tags with an IN of matching arity", () => {
    const { sql, params } = buildPictureQuery({
      mode: MODES.SUBSTRING,
      parsed: noQuery,
      filters: { pictureTags: ["seal", "sig"] },
    });
    expect(sql).toContain("(p.tag IN (?, ?))");
    expect(params).toEqual(["seal", "sig"]);
  });

  it("translates the untagged option to IS NULL, not to a literal", () => {
    // "none" is the transport encoding for a NULL tag. Comparing it as text
    // would match nothing and the chip would always read empty.
    const { sql, params } = buildPictureQuery({
      mode: MODES.SUBSTRING,
      parsed: noQuery,
      filters: { pictureTags: ["none"] },
    });
    expect(sql).toContain("(p.tag IS NULL)");
    expect(params).toEqual([]);
  });

  it("ORs a mixed selection rather than ANDing it to nothing", () => {
    const { sql, params } = buildPictureQuery({
      mode: MODES.SUBSTRING,
      parsed: noQuery,
      filters: { pictureTags: ["sig", "none"] },
    });
    expect(sql).toContain("(p.tag IN (?) OR p.tag IS NULL)");
    expect(params).toEqual(["sig"]);
  });

  it("selecting every type is not the same clause as selecting none", () => {
    const all = buildPictureQuery({
      mode: MODES.SUBSTRING,
      parsed: noQuery,
      filters: { pictureTags: ["seal", "sig", "none"] },
    });
    const any = buildPictureQuery({ mode: MODES.SUBSTRING, parsed: noQuery, filters: {} });
    expect(all.sql).toContain("p.tag");
    expect(any.sql).not.toContain("p.tag IN");
  });
});

describe("buildPictureCountQuery", () => {
  it("reports both totals over the same predicate as the grid", () => {
    const args = {
      mode: MODES.SUBSTRING,
      parsed: parseQuery("moses"),
      filters: { pictureTags: ["sig"] },
    };
    const { sql, params } = buildPictureCountQuery(args);
    expect(sql).toContain("count(*) AS n_pictures");
    expect(sql).toContain("count(DISTINCT m.eo_id) AS n_orders");
    expect(sql).toContain("p.tag IN (?)");
    expect(params).toEqual(buildPictureQuery(args).params);
    expect(sql).not.toContain("LIMIT");
  });
});

describe("buildPictureTagQuery", () => {
  it("drops the tag filter from its own predicate but keeps everything else", () => {
    // Same self-excluding rule the column facets follow: the number on a chip
    // has to be what clicking it would yield, not what it yields already.
    const { sql, params } = buildPictureTagQuery({
      mode: MODES.SUBSTRING,
      parsed: parseQuery("moses"),
      filters: { mayor: ["Wagner"], pictureTags: ["sig"] },
    });
    expect(sql).not.toContain("p.tag IN");
    expect(sql).toContain("coalesce(p.tag, 'none') AS value");
    expect(params).toEqual(["Wagner", "moses"]);
  });

  it("does not mutate the caller's filters", () => {
    const filters = { pictureTags: ["sig"] };
    buildPictureTagQuery({ mode: MODES.SUBSTRING, parsed: noQuery, filters });
    expect(filters.pictureTags).toEqual(["sig"]);
  });
});
