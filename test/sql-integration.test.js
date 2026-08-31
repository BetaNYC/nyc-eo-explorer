/**
 * Run every SQL shape the app can emit against a REAL DuckDB and the REAL
 * Parquet artifacts.
 *
 * A unit test on a SQL string builder can only prove it produced the string you
 * expected -- not that the string compiles, or that a LIST column survives a
 * comparison, or that a DATE lines up with a VARCHAR. That class of failure only
 * shows up against an engine, which is what this file is for.
 *
 * It runs against @duckdb/node-api (DuckDB 1.5.x) while the browser runs
 * duckdb-wasm 1.32.0 (DuckDB 1.4.3). For the surface this app uses -- scans,
 * filters, group-bys, contains, regexp_matches -- that gap is immaterial.
 *
 * Skips itself when public/data has not been built, so `npm test` works on a
 * fresh clone before `npm run data`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DuckDBInstance } from "@duckdb/node-api";
import { beforeAll, describe, expect, it } from "vitest";

import { flattenPictures } from "../src/data/pictures.js";
import { parseQuery } from "../src/search/parseQuery.js";
import {
  AGENCY_TAIL,
  MODES,
  RANKINGS,
  buildAgencyCountStatsQuery,
  buildAgencyHistogramQuery,
  buildCooccurrenceEdgesQuery,
  buildCooccurrenceQuery,
  buildCountQuery,
  buildEntitiesForEoQuery,
  buildEntityIndexCountQuery,
  buildEntityIndexQuery,
  buildEntityLineageQuery,
  buildEntityNamesQuery,
  buildEntityQuery,
  buildEntityYearsQuery,
  buildFacetQuery,
  buildRingEligibilityQuery,
  buildMentionSpansQuery,
  buildPictureCountQuery,
  buildPictureQuery,
  buildPictureTagQuery,
  buildSearchQuery,
} from "../src/search/sql.js";

const DATA = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const HAVE_DATA = existsSync(join(DATA, "eo_meta.parquet"));

// Counts are derived from the built artifacts, never hardcoded. The corpus is
// actively growing -- the pre-1974 volumes took it from 2,291 to 3,352 mid
// development -- so absolute pins would fail on every upstream rebuild and
// train everyone to ignore this suite. Relational invariants (the parts sum to
// the whole, a facet partitions the corpus) catch real regressions and survive
// a bigger corpus.
const MANIFEST = HAVE_DATA
  ? JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8"))
  : null;

const d = HAVE_DATA ? describe : describe.skip;

d("generated SQL against real DuckDB + real Parquet", () => {
  let conn;

  const run = async (sql, params = []) => {
    const reader = params.length
      ? await conn.runAndReadAll(sql, params)
      : await conn.runAndReadAll(sql);
    return reader.getRowObjects();
  };

  beforeAll(async () => {
    const instance = await DuckDBInstance.create(":memory:");
    conn = await instance.connect();
    const p = (n) => join(DATA, n).replace(/'/g, "''");
    await conn.run(`CREATE TABLE eo_meta AS SELECT * FROM '${p("eo_meta.parquet")}'`);
    await conn.run(`
      CREATE TABLE eo_text AS
      SELECT eo_id, full_text,
             coalesce(full_text_raw, full_text) AS full_text_raw,
             lower(full_text) AS full_text_lc
      FROM '${p("eo_text.parquet")}'`);
    await conn.run(`CREATE TABLE edges AS SELECT * FROM '${p("supersession_edges.parquet")}'`);

    // The same three tables src/duckdb/store.js builds, including the derived
    // DISTINCT (order, agency) one every agency query actually reads.
    await conn.run(`CREATE TABLE entities AS SELECT * FROM '${p("entities.parquet")}'`);
    await conn.run(
      `CREATE TABLE entity_mentions AS SELECT * FROM '${p("entity_mentions.parquet")}'`
    );
    // Mirrors src/duckdb/store.js, `NOT in_letterhead` included -- the point of
    // this file is to run the real queries against the real Parquet, and a
    // harness that builds a different table tests nothing.
    await conn.run(`
      CREATE TABLE eo_entity AS
      SELECT eo_id, entity_id, count(*) AS n FROM entity_mentions
      WHERE NOT in_letterhead GROUP BY 1, 2`);
    await conn.run(`
      CREATE TABLE eo_agencies AS
      SELECT eo_id, count(*) AS agencies FROM eo_entity GROUP BY 1`);

    // The browser builds this table by handing DuckDB newline-delimited JSON
    // (src/duckdb/store.js). The rows come from the SAME flattener, so what is
    // asserted below is the shape that actually ships; only the load path
    // differs, because node-api has no registerFileText.
    const byEo = JSON.parse(readFileSync(join(DATA, "pictures.json"), "utf8")).by_eo;
    const picRows = flattenPictures(byEo);
    await conn.run(
      `CREATE TABLE pictures (eo_id VARCHAR, image VARCHAR, tag VARCHAR, page INTEGER)`
    );
    for (let i = 0; i < picRows.length; i += 500) {
      const chunk = picRows.slice(i, i + 500);
      await conn.run(
        `INSERT INTO pictures VALUES ${chunk.map(() => "(?, ?, ?, ?)").join(", ")}`,
        chunk.flatMap((r) => [r.eo_id, r.image, r.tag, r.page])
      );
    }
  });

  it("browses with no filters at all", async () => {
    const q = buildSearchQuery({ mode: MODES.SUBSTRING, parsed: parseQuery(""), filters: {} });
    const rows = await run(q.sql, q.params);
    expect(rows.length).toBe(50);
    expect(rows[0].eo_id).toBeTruthy();
  });

  it("counts the whole corpus", async () => {
    const c = buildCountQuery({
      mode: MODES.SUBSTRING,
      parsed: parseQuery(""),
      filters: {},
    });
    const [row] = await run(c.sql, c.params);
    expect(Number(row.n)).toBe(MANIFEST.record_count);
  });

  it("applies every facet at once without a dialect error", async () => {
    const filters = {
      mayor: ["Koch", "Dinkins"],
      text_quality: ["clean"],
      source: ["wayback"],
      yearMin: 1978,
      yearMax: 1992,
      isEmergency: false,
    };
    const q = buildSearchQuery({ mode: MODES.SUBSTRING, parsed: parseQuery(""), filters });
    const rows = await run(q.sql, q.params);
    for (const r of rows) {
      expect(["Koch", "Dinkins"]).toContain(r.mayor);
      expect(r.year).toBeGreaterThanOrEqual(1978);
      expect(r.year).toBeLessThanOrEqual(1992);
      expect(r.is_emergency).toBe(false);
    }
  });

  it("distinguishes regular from emergency (the tri-state bug, end to end)", async () => {
    const mk = (isEmergency) =>
      buildCountQuery({
        mode: MODES.SUBSTRING,
        parsed: parseQuery(""),
        filters: { isEmergency },
      });
    const cFalse = mk(false);
    const cTrue = mk(true);
    const [f] = await run(cFalse.sql, cFalse.params);
    const [t] = await run(cTrue.sql, cTrue.params);
    // is_emergency partitions the corpus: neither side may be empty, and the
    // two must sum to the whole. That is what the tri-state bug would break.
    expect(Number(f.n)).toBeGreaterThan(0);
    expect(Number(t.n)).toBeGreaterThan(0);
    expect(Number(f.n) + Number(t.n)).toBe(MANIFEST.record_count);
  });

  it("runs a substring search and finds real hits", async () => {
    const q = buildSearchQuery({
      mode: MODES.SUBSTRING,
      parsed: parseQuery("commissioner"),
      filters: {},
    });
    const rows = await run(q.sql, q.params);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("runs a quoted phrase search", async () => {
    const q = buildSearchQuery({
      mode: MODES.SUBSTRING,
      parsed: parseQuery('"office of the mayor"'),
      filters: {},
    });
    const rows = await run(q.sql, q.params);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("runs an exclusion without excluding everything", async () => {
    const withOut = buildSearchQuery({
      mode: MODES.SUBSTRING,
      parsed: parseQuery("city -emergency"),
      filters: {},
    });
    const rows = await run(withOut.sql, withOut.params);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("runs a regex search, including an OCR-tolerant character class", async () => {
    const q = buildSearchQuery({
      mode: MODES.REGEX,
      parsed: parseQuery("comm[il1]ssioner"),
      filters: {},
    });
    const rows = await run(q.sql, q.params);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("handles an apostrophe in a bound facet value", async () => {
    // O'Dwyer arrived with the pre-1974 volumes. An interpolated apostrophe is
    // a syntax error, so what matters is that this executes at all -- and that
    // whatever comes back is actually filtered.
    const q = buildSearchQuery({
      mode: MODES.SUBSTRING,
      parsed: parseQuery(""),
      filters: { mayor: ["O'Dwyer"] },
    });
    const rows = await run(q.sql, q.params);
    for (const r of rows) expect(r.mayor).toBe("O'Dwyer");
  });

  it("builds facet counts that sum to the corpus", async () => {
    const { sql, params } = buildFacetQuery("mayor", {});
    const rows = await run(sql, params);
    expect(rows.map((r) => r.value)).toContain("Adams");
    expect(rows.reduce((a, r) => a + Number(r.n), 0)).toBe(MANIFEST.record_count);
  });

  it("narrows one facet by the others", async () => {
    const { sql, params } = buildFacetQuery("mayor", { text_quality: ["no-text"] });
    const rows = await run(sql, params);
    const [expected] = await run(
      `SELECT count(*) AS n FROM eo_meta WHERE text_quality = 'no-text'`
    );
    expect(rows.reduce((a, r) => a + Number(r.n), 0)).toBe(Number(expected.n));
  });

  it("runs the analytics queries", async () => {
    const byYear = await run(`SELECT year,
        count(*) FILTER (NOT is_emergency) AS regular,
        count(*) FILTER (is_emergency)     AS emergency,
        count(*)                           AS total
      FROM eo_meta GROUP BY year ORDER BY year`);
    expect(byYear.length).toBeGreaterThan(40);
    expect(Number(byYear[0].year)).toBe(MANIFEST.year_min);

    const [cov] = await run(`SELECT count(*) AS total,
        count(*) FILTER (text_quality <> 'no-text') AS with_text,
        count(*) FILTER (title IS NOT NULL) AS with_title,
        count(*) FILTER (date_signed IS NOT NULL) AS with_date
      FROM eo_meta`);
    const total = MANIFEST.record_count;
    expect(Number(cov.total)).toBe(total);
    expect(Number(cov.with_date)).toBeLessThan(total); // some dates are unknown
    expect(Number(cov.with_title)).toBeLessThan(total);

    // Orders with no recoverable text still carry the 19-char
    // "_No text available_" stub, so a char_count test would report full
    // coverage and the meter would claim 100%. This must track text_quality.
    const [noText] = await run(
      `SELECT count(*) AS n FROM eo_meta WHERE text_quality = 'no-text'`
    );
    expect(Number(noText.n)).toBeGreaterThan(0);
    expect(Number(cov.with_text)).toBe(total - Number(noText.n));
  });

  it("char_count is never zero, which is why coverage must test text_quality", async () => {
    const [row] = await run(`SELECT count(*) AS n FROM eo_meta WHERE char_count = 0`);
    expect(Number(row.n)).toBe(0);
  });

  it("joins the edge table in both directions", async () => {
    const out = await run(
      `SELECT e.*, m.title FROM edges e LEFT JOIN eo_meta m ON m.eo_id = e.target
       WHERE e.actor = ?`,
      ["1975-EO-040"]
    );
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].verb).toBeTruthy();
  });

  it("reads a LIST column back as an array", async () => {
    // VARCHAR[] round-tripping through Parquet is the kind of thing that
    // silently becomes a string in a lesser pipeline.
    const rows = await run(`SELECT supersedes FROM eo_meta WHERE len(supersedes) > 0 LIMIT 1`);
    expect(Array.isArray(rows[0].supersedes.items ?? rows[0].supersedes)).toBe(true);
  });

  it("kept `number` as text, including the zero-padded form", async () => {
    const rows = await run(`SELECT number FROM eo_meta WHERE number = '001' LIMIT 1`);
    expect(rows.length).toBe(1);
    expect(rows[0].number).toBe("001");
  });

  // Crops exist only where the upstream clipping side-car has run, so the whole
  // group skips itself when the build joined none.
  const dPics = HAVE_DATA && MANIFEST.picture_count > 0 ? describe : describe.skip;

  dPics("picture gallery", () => {
    it("loaded every crop the build joined, and no order twice over", async () => {
      const [row] = await run(
        `SELECT count(*) AS n, count(DISTINCT eo_id) AS orders FROM pictures`
      );
      expect(Number(row.n)).toBe(MANIFEST.picture_count);
      expect(Number(row.orders)).toBe(MANIFEST.picture_orders);
    });

    it("the three tag buckets partition the crops, untagged included", async () => {
      // NULL is a third answer, not a synonym for "neither". If the flattener
      // or the column type ever coerced it, seal + sig would equal the whole
      // and the untagged chip would be permanently empty.
      const [row] = await run(`SELECT count(*) FILTER (tag = 'seal')  AS seal,
                                      count(*) FILTER (tag = 'sig')   AS sig,
                                      count(*) FILTER (tag IS NULL)   AS untagged,
                                      count(*)                        AS total
                               FROM pictures`);
      expect(Number(row.seal)).toBeGreaterThan(0);
      expect(Number(row.sig)).toBeGreaterThan(0);
      expect(Number(row.untagged)).toBeGreaterThan(0);
      expect(Number(row.seal) + Number(row.sig) + Number(row.untagged)).toBe(Number(row.total));
    });

    it("browses every crop without touching the text table", async () => {
      const q = buildPictureQuery({
        mode: MODES.SUBSTRING,
        parsed: parseQuery(""),
        filters: {},
        limit: 200,
      });
      const rows = await run(q.sql, q.params);
      expect(rows.length).toBe(200);
      expect(rows[0].image).toBeTruthy();
      expect(rows[0].eo_id).toBeTruthy();
    });

    it("the join cannot invent an order that is not in the corpus", async () => {
      const [row] = await run(
        `SELECT count(*) AS n FROM pictures p
         WHERE NOT EXISTS (SELECT 1 FROM eo_meta m WHERE m.eo_id = p.eo_id)`
      );
      expect(Number(row.n)).toBe(0);
    });

    it("counts the unfiltered gallery to exactly the manifest's totals", async () => {
      const c = buildPictureCountQuery({
        mode: MODES.SUBSTRING,
        parsed: parseQuery(""),
        filters: {},
      });
      const [row] = await run(c.sql, c.params);
      expect(Number(row.n_pictures)).toBe(MANIFEST.picture_count);
      expect(Number(row.n_orders)).toBe(MANIFEST.picture_orders);
    });

    it("a search narrows the gallery without emptying it", async () => {
      // "commissioner" is everywhere in this corpus, including the volumes the
      // crops came from, so this is a real join across both tables.
      const args = {
        mode: MODES.SUBSTRING,
        parsed: parseQuery("commissioner"),
        filters: {},
      };
      const c = buildPictureCountQuery(args);
      const [pics] = await run(c.sql, c.params);
      expect(Number(pics.n_pictures)).toBeGreaterThan(0);
      expect(Number(pics.n_pictures)).toBeLessThan(MANIFEST.picture_count);

      // Pictures narrow, never widen: the orders contributing crops are a
      // subset of the orders the same search matched.
      const s = buildCountQuery(args);
      const [orders] = await run(s.sql, s.params);
      expect(Number(pics.n_orders)).toBeLessThanOrEqual(Number(orders.n));
    });

    it("filters to one type, and to the untagged bucket, through real SQL", async () => {
      const mk = (pictureTags) =>
        buildPictureQuery({
          mode: MODES.SUBSTRING,
          parsed: parseQuery(""),
          filters: { pictureTags },
          limit: 50,
        });
      const sig = mk(["sig"]);
      for (const r of await run(sig.sql, sig.params)) expect(r.tag).toBe("sig");

      const none = mk(["none"]);
      const noneRows = await run(none.sql, none.params);
      expect(noneRows.length).toBeGreaterThan(0);
      for (const r of noneRows) expect(r.tag).toBe(null);

      const mixed = mk(["sig", "none"]);
      for (const r of await run(mixed.sql, mixed.params))
        expect([null, "sig"]).toContain(r.tag);
    });

    it("tag counts sum to the total and ignore the tag filter itself", async () => {
      const args = { mode: MODES.SUBSTRING, parsed: parseQuery(""), filters: {} };
      const t = buildPictureTagQuery(args);
      const rows = await run(t.sql, t.params);
      expect(rows.map((r) => r.value)).toEqual(["none", "seal", "sig"]);
      expect(rows.reduce((a, r) => a + Number(r.n), 0)).toBe(MANIFEST.picture_count);

      // With "sig" already selected, the other chips must still report what
      // clicking them would yield -- identical numbers, not zeroes.
      const narrowed = buildPictureTagQuery({ ...args, filters: { pictureTags: ["sig"] } });
      const after = await run(narrowed.sql, narrowed.params);
      expect(after).toEqual(rows);
    });

    it("picture-restricted facet counts sum to the orders that have crops", async () => {
      const { sql, params } = buildFacetQuery("mayor", {}, { pictures: true });
      const rows = await run(sql, params);
      expect(rows.reduce((a, r) => a + Number(r.n), 0)).toBe(MANIFEST.picture_orders);
      // And they are strictly a subset of the unrestricted counts.
      const plain = buildFacetQuery("mayor", {});
      const all = Object.fromEntries(
        (await run(plain.sql, plain.params)).map((r) => [r.value, r.n])
      );
      for (const r of rows) expect(Number(r.n)).toBeLessThanOrEqual(Number(all[r.value]));
    });

    it("survives an apostrophe mayor and a regex query on the same join", async () => {
      const q = buildPictureQuery({
        mode: MODES.REGEX,
        parsed: parseQuery("comm[il1]ssioner"),
        filters: { mayor: ["O'Dwyer"], pictureTags: ["seal"] },
        limit: 20,
      });
      for (const r of await run(q.sql, q.params)) {
        expect(r.mayor).toBe("O'Dwyer");
        expect(r.tag).toBe("seal");
      }
    });
  });

  // Page provenance rides in from the pre-1974 sidecar, so it is only there when
  // that optional input was on disk at build time.
  const dPages = HAVE_DATA && MANIFEST.page_provenance_count > 0 ? describe : describe.skip;

  dPages("page provenance", () => {
    it("covers every volume-derived order and no other", async () => {
      // An order cut out of a bound volume must be citable to a page; an order
      // with a PDF of its own must not claim a page number it does not have.
      const [row] = await run(`
        SELECT count(*) FILTER (source = 'gpp-volume' AND source_page_start IS NULL) AS volume_missing,
               count(*) FILTER (source <> 'gpp-volume' AND source_page_start IS NOT NULL) AS other_has,
               count(*) FILTER (source_page_start IS NOT NULL) AS with_pages
        FROM eo_meta`);
      expect(Number(row.volume_missing)).toBe(0);
      expect(Number(row.other_has)).toBe(0);
      expect(Number(row.with_pages)).toBe(MANIFEST.page_provenance_count);
    });

    it("starts at the first page of the list, which is ascending and 1-based", async () => {
      const [row] = await run(`
        SELECT count(*) FILTER (source_page_start <> source_pages[1]) AS bad_start,
               count(*) FILTER (list_min(source_pages) < 1)           AS bad_page,
               count(*) FILTER (source_pages <> list_sort(source_pages)) AS unsorted
        FROM eo_meta WHERE source_pages IS NOT NULL`);
      expect(Number(row.bad_start)).toBe(0);
      expect(Number(row.bad_page)).toBe(0);
      expect(Number(row.unsorted)).toBe(0);
    });

    it("carries the page list, not a span: len(pages) matches page_count", async () => {
      // 153 records skip blank versos -- 1946-EO-D0916 is pages 44, 46, 48, 50 --
      // so last - first + 1 would claim pages the order is not on.
      const [row] = await run(
        `SELECT count(*) AS n FROM eo_meta
         WHERE source_pages IS NOT NULL AND len(source_pages) <> page_count`
      );
      expect(Number(row.n)).toBe(0);
    });
  });

  describe("agencies", () => {
    // Picked out of the built data rather than hardcoded, so the suite keeps
    // working as the corpus grows and the counts move.
    let busiest;
    let small;
    let busiestOrder;

    beforeAll(async () => {
      [busiest] = await run(`SELECT * FROM entities ORDER BY eo_count DESC LIMIT 1`);
      [{ eo_id: busiestOrder }] = await run(
        `SELECT eo_id FROM entity_mentions GROUP BY 1
         ORDER BY count(*) - count(DISTINCT entity_id) DESC, eo_id LIMIT 1`
      );
      [small] = await run(
        `SELECT * FROM entities WHERE eo_count BETWEEN 4 AND 8 ORDER BY entity_id LIMIT 1`
      );
    });

    it("has both kinds, and far more proposed than confirmed", async () => {
      // The registry holds active agencies only, so every dissolved body is a
      // proposed one. If that ratio ever inverts, the scan changed meaning.
      const rows = await run(`SELECT kind, count(*) AS n FROM entities GROUP BY 1`);
      const by = Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)]));
      expect(by.registry).toBeGreaterThan(0);
      expect(by.proposed).toBeGreaterThan(by.registry);
      expect(by.registry + by.proposed).toBe(MANIFEST.entity_count);
    });

    it("names no order the corpus does not hold", async () => {
      const [row] = await run(
        `SELECT count(*) AS n FROM entity_mentions m
         LEFT JOIN eo_meta e USING (eo_id) WHERE e.eo_id IS NULL`
      );
      expect(Number(row.n)).toBe(0);
    });

    it("gives every mention an entity that can be named", async () => {
      const [row] = await run(
        `SELECT count(*) AS n FROM entity_mentions m
         LEFT JOIN entities e USING (entity_id)
         WHERE e.entity_id IS NULL OR e.display_name IS NULL`
      );
      expect(Number(row.n)).toBe(0);
    });

    it("keeps the counts on an entity equal to what the mentions say", async () => {
      // Body only, on both sides. `entities.mention_count` leaves the letterhead
      // out because the mayoral stationery names the office at the head of
      // nearly every order; `letterhead_count` carries it, and the next test
      // checks the two still add up to every row in the table.
      const [row] = await run(`
        SELECT count(*) AS wrong FROM entities e
        JOIN (SELECT entity_id, count(DISTINCT eo_id) AS eos, count(*) AS mentions
              FROM entity_mentions WHERE NOT in_letterhead GROUP BY 1) t USING (entity_id)
        WHERE e.eo_count <> t.eos OR e.mention_count <> t.mentions`);
      expect(Number(row.wrong)).toBe(0);
    });

    it("accounts for every mention, letterhead included", async () => {
      // Nothing is dropped on the way into the tables: what the entity rows
      // count plus what they set aside is the whole of entity_mentions.
      const [{ total }] = await run(`SELECT count(*) AS total FROM entity_mentions`);
      const [{ counted }] = await run(
        `SELECT sum(mention_count) + sum(letterhead_count) AS counted FROM entities`
      );
      expect(Number(counted)).toBe(Number(total));
    });

    it("marks the letterhead on the mayor alone, and leaves it out of eo_entity", async () => {
      // The whole point of the mark. Upstream judges only the mayoral masthead,
      // so any other agency turning up here means the rule was widened without
      // this test being revisited.
      const marked = await run(
        `SELECT DISTINCT entity_id FROM entity_mentions WHERE in_letterhead`
      );
      expect(marked.map((r) => r.entity_id)).toEqual(["office-of-the-mayor"]);
      const [{ n }] = await run(
        `SELECT count(*) AS n FROM eo_entity WHERE entity_id = 'office-of-the-mayor'`
      );
      const [{ body }] = await run(
        `SELECT count(DISTINCT eo_id) AS body FROM entity_mentions
         WHERE entity_id = 'office-of-the-mayor' AND NOT in_letterhead`
      );
      expect(Number(n)).toBe(Number(body));
    });

    it("lists the agencies in one order, in the order they are named", async () => {
      const q = buildEntitiesForEoQuery(busiest ? await anyOrderFor(busiest.entity_id) : "");
      const rows = await run(q.sql, q.params);
      expect(rows.length).toBeGreaterThan(0);
      const at = rows.map((r) => Number(r.first_at));
      expect(at).toEqual([...at].sort((a, b) => a - b));
      expect(rows.every((r) => r.display_name)).toBe(true);
    });

    it("returns spans that really do sit inside the order text", async () => {
      // The whole marked-text view rests on this. Upstream proves
      // full_text[start:end] === text; this proves the offsets survived the
      // trip through JSON, Parquet and back.
      const eoId = await anyOrderFor(busiest.entity_id);
      const q = buildMentionSpansQuery(eoId);
      const spans = await run(q.sql, q.params);
      const [{ full_text: body }] = await run(`SELECT full_text FROM eo_text WHERE eo_id = ?`, [
        eoId,
      ]);
      expect(spans.length).toBeGreaterThan(0);
      for (const s of spans) {
        expect(Number(s.start)).toBeGreaterThanOrEqual(0);
        expect(Number(s.end)).toBeLessThanOrEqual(body.length);
        expect(Number(s.end)).toBeGreaterThan(Number(s.start));
      }
    });

    it("fetches one agency's own record", async () => {
      const q = buildEntityQuery(busiest.entity_id);
      const [row] = await run(q.sql, q.params);
      expect(row.entity_id).toBe(busiest.entity_id);
      expect(row.display_name).toBeTruthy();
    });

    it("returns nothing, rather than throwing, for an agency that does not exist", async () => {
      const q = buildEntityQuery("x-no-such-agency-anywhere");
      expect(await run(q.sql, q.params)).toEqual([]);
    });

    it("indexes agencies, and the count matches the list", async () => {
      const args = { q: "", kinds: [], minOrders: 1 };
      const rows = await run(...two(buildEntityIndexQuery({ ...args, limit: 10 })));
      const [counted] = await run(...two(buildEntityIndexCountQuery(args)));
      expect(rows).toHaveLength(10);
      expect(Number(counted.n)).toBe(MANIFEST.entity_count);
      // Most-cited first.
      const counts = rows.map((r) => Number(r.eo_count));
      expect(counts).toEqual([...counts].sort((a, b) => b - a));
    });

    it("finds an agency by an alternate spelling, not only by its title", async () => {
      // The page is titled "Department of Information Technology and
      // Telecommunications"; nobody types that.
      const q = buildEntityIndexQuery({ q: "doitt", kinds: [], minOrders: 1, limit: 5 });
      const rows = await run(q.sql, q.params);
      expect(rows.length).toBeGreaterThan(0);
    });

    it("filters the index by kind and by how many orders name it", async () => {
      const q = buildEntityIndexQuery({
        q: "",
        kinds: ["registry"],
        minOrders: 10,
        limit: 100,
      });
      const rows = await run(q.sql, q.params);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.kind === "registry")).toBe(true);
      expect(rows.every((r) => Number(r.eo_count) >= 10)).toBe(true);
    });

    it("lists an agency's orders oldest first, one row per order", async () => {
      const q = buildEntityLineageQuery(busiest.entity_id);
      const rows = await run(q.sql, q.params);
      expect(rows).toHaveLength(Number(busiest.eo_count));
      const years = rows.map((r) => Number(r.year));
      expect(years).toEqual([...years].sort((a, b) => a - b));
      expect(new Set(rows.map((r) => r.eo_id)).size).toBe(rows.length);
    });

    it("agrees with the entity row about when the agency is first and last named", async () => {
      const q = buildEntityLineageQuery(busiest.entity_id);
      const rows = await run(q.sql, q.params);
      expect(Number(rows[0].year)).toBe(Number(busiest.first_year));
      expect(Number(rows[rows.length - 1].year)).toBe(Number(busiest.last_year));
    });

    it("counts an agency's orders per year", async () => {
      const q = buildEntityYearsQuery(busiest.entity_id);
      const rows = await run(q.sql, q.params);
      const total = rows.reduce((n, r) => n + Number(r.n), 0);
      expect(total).toBe(Number(busiest.eo_count));
    });

    it("never puts an agency in its own co-mention graph", async () => {
      const q = buildCooccurrenceQuery(busiest.entity_id, { limit: 24, minShared: 2 });
      const rows = await run(q.sql, q.params);
      expect(rows.every((r) => r.entity_id !== busiest.entity_id)).toBe(true);
    });

    it("ranks by affinity and by shared orders, and they are different questions", async () => {
      const opts = { limit: 12 };
      const byAffinity = await run(
        ...two(
          buildCooccurrenceQuery(busiest.entity_id, { ...opts, ranking: RANKINGS.AFFINITY })
        )
      );
      const byShared = await run(
        ...two(buildCooccurrenceQuery(busiest.entity_id, { ...opts, ranking: RANKINGS.SHARED }))
      );
      const affinities = byAffinity.map((r) => Number(r.affinity));
      expect(affinities).toEqual([...affinities].sort((a, b) => b - a));
      const shares = byShared.map((r) => Number(r.shared));
      expect(shares).toEqual([...shares].sort((a, b) => b - a));
      // If the two rankings returned the same agencies in the same order, the
      // toggle would be decoration. On the busiest agency they never do.
      expect(byAffinity.map((r) => r.entity_id)).not.toEqual(byShared.map((r) => r.entity_id));
    });

    it("keeps affinity a real share, never above 1", async () => {
      const rows = await run(...two(buildCooccurrenceQuery(busiest.entity_id, { limit: 24 })));
      for (const r of rows) {
        expect(Number(r.affinity)).toBeGreaterThan(0);
        expect(Number(r.affinity)).toBeLessThanOrEqual(1);
        // Jaccard by definition: shared / (mine + theirs - shared).
        const expected =
          Number(r.shared) / (Number(busiest.eo_count) + Number(r.eo_count) - Number(r.shared));
        expect(Number(r.affinity)).toBeCloseTo(expected, 10);
      }
    });

    it("does not let a thin near-duplicate outrank a real partner", async () => {
      // The measure this replaced (lift) put a 4-order fragment above the
      // Comptroller on the Board of Estimate, because the pattern pass proposes
      // thousands of such fragments and every one of them scores perfectly.
      const [boe] = await run(`SELECT * FROM entities WHERE entity_id = 'x-board-of-estimate'`);
      if (!boe) return;
      const rows = await run(...two(buildCooccurrenceQuery(boe.entity_id, { limit: 6 })));
      // Everything on the ring shares a real fraction of the agency's orders.
      expect(rows.every((r) => Number(r.shared) >= 10)).toBe(true);
    });

    it("honours the floor on shared orders", async () => {
      const q = buildCooccurrenceQuery(busiest.entity_id, { limit: 24, minShared: 5 });
      const rows = await run(q.sql, q.params);
      expect(rows.every((r) => Number(r.shared) >= 5)).toBe(true);
    });

    it("draws a partner that shares a single order", async () => {
      // The default floor is ONE. 1,503 of the 2,338 agencies are named in
      // exactly one order, so a floor of two is unreachable for them and used to
      // empty 1,614 of the 2,338 pages. The cap on agencies-per-order is the
      // control that filters; this number must not filter behind it.
      const [one] = await run(
        `SELECT e.entity_id FROM entities e
         WHERE e.eo_count = 1
           AND EXISTS (SELECT 1 FROM eo_entity a JOIN eo_entity b USING (eo_id)
                       WHERE a.entity_id = e.entity_id AND b.entity_id <> e.entity_id)
         ORDER BY e.entity_id LIMIT 1`
      );
      expect(one).toBeDefined();
      const q = buildCooccurrenceQuery(one.entity_id, { limit: 24 });
      const rows = await run(q.sql, q.params);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => Number(r.shared) === 1)).toBe(true);
    });

    it("leaves an agency empty only when its orders name nobody else", async () => {
      // The other half of the same promise: with no cap set, an empty ring means
      // the corpus is empty there, never that a threshold hid something.
      const [{ n }] = await run(
        `SELECT count(*) AS n FROM entities e
         WHERE NOT EXISTS (SELECT 1 FROM eo_entity a JOIN eo_entity b USING (eo_id)
                           WHERE a.entity_id = e.entity_id AND b.entity_id <> e.entity_id)`
      );
      // Measured 2026-08-27: 49 of 2,338, down from 1,614 under the old floor.
      expect(Number(n)).toBeLessThan(100);
    });

    it("still draws something for an agency named in only a few orders", async () => {
      // Affinity needs no cutoff tuned per agency: a big denominator at both
      // ends already suppresses the letterhead and the fragment, so one floor
      // works for a 6-order agency and a 2,449-order one alike.
      const q = buildCooccurrenceQuery(small.entity_id, { limit: 24 });
      expect((await run(q.sql, q.params)).length).toBeGreaterThan(0);
    });

    it("returns edges only between agencies on the ring, each pair once", async () => {
      const nodes = await run(...two(buildCooccurrenceQuery(busiest.entity_id, { limit: 12 })));
      const ids = nodes.map((n) => n.entity_id);
      const q = buildCooccurrenceEdgesQuery(ids, { minShared: 2 });
      const edges = await run(q.sql, q.params);
      const onRing = new Set(ids);
      for (const e of edges) {
        expect(onRing.has(e.src)).toBe(true);
        expect(onRing.has(e.dst)).toBe(true);
        expect(e.src < e.dst).toBe(true);
      }
      expect(new Set(edges.map((e) => `${e.src}~${e.dst}`)).size).toBe(edges.length);
    });

    it("asks for no edges at all when the ring is too small to have any", async () => {
      expect(buildCooccurrenceEdgesQuery([], {})).toBeNull();
      expect(buildCooccurrenceEdgesQuery(["only-one"], {})).toBeNull();
    });

    it("narrows to the orders naming every agency chosen, never any one of them", async () => {
      const ring = await run(...two(buildCooccurrenceQuery(busiest.entity_id, { limit: 2 })));
      const [a, b] = ring.map((r) => r.entity_id);

      const alone = await run(...two(buildEntityLineageQuery(busiest.entity_id)));
      const withA = await run(...two(buildEntityLineageQuery(busiest.entity_id, [a])));
      const withBoth = await run(...two(buildEntityLineageQuery(busiest.entity_id, [a, b])));

      // Intersection, so every step can only take orders away.
      expect(withA.length).toBeLessThanOrEqual(alone.length);
      expect(withBoth.length).toBeLessThanOrEqual(withA.length);

      // And every order that survives really does name all three. A union bug
      // would pass the length checks above and fail here.
      const wanted = new Set([busiest.entity_id, a, b]);
      for (const o of withBoth) {
        const named = new Set(
          (await run(`SELECT entity_id FROM eo_entity WHERE eo_id = ?`, [o.eo_id])).map(
            (r) => r.entity_id
          )
        );
        for (const id of wanted)
          expect(named.has(id), `${o.eo_id} is missing ${id}`).toBe(true);
      }
    });

    it("keeps the year strip and the order list telling the same story", async () => {
      const [a] = (
        await run(...two(buildCooccurrenceQuery(busiest.entity_id, { limit: 1 })))
      ).map((r) => r.entity_id);
      const orders = await run(...two(buildEntityLineageQuery(busiest.entity_id, [a])));
      const years = await run(...two(buildEntityYearsQuery(busiest.entity_id, [a])));
      expect(years.reduce((n, r) => n + Number(r.n), 0)).toBe(orders.length);
    });

    it("ignores an agency named twice in the filter", async () => {
      // A hand-edited link can repeat one. Counting it twice would raise the
      // bar past what any order can clear and empty the list.
      const [a] = (
        await run(...two(buildCooccurrenceQuery(busiest.entity_id, { limit: 1 })))
      ).map((r) => r.entity_id);
      const once = await run(...two(buildEntityLineageQuery(busiest.entity_id, [a])));
      const twice = await run(...two(buildEntityLineageQuery(busiest.entity_id, [a, a])));
      const itself = await run(
        ...two(buildEntityLineageQuery(busiest.entity_id, [busiest.entity_id]))
      );
      expect(twice.length).toBe(once.length);
      expect(itself.length).toBe(Number(busiest.eo_count));
    });

    it("returns nothing at all for a combination no order satisfies", async () => {
      const rows = await run(
        ...two(buildEntityLineageQuery(busiest.entity_id, ["x-no-such-agency-anywhere"]))
      );
      expect(rows).toEqual([]);
    });

    it("says which agencies could still be added, and greys the rest", async () => {
      const ring = (
        await run(...two(buildCooccurrenceQuery(busiest.entity_id, { limit: 24 })))
      ).map((r) => r.entity_id);
      const [a] = ring;
      const q = buildRingEligibilityQuery(busiest.entity_id, [a], ring);
      const reachable = new Map(
        (await run(q.sql, q.params)).map((r) => [r.entity_id, Number(r.n)])
      );

      // Every count it reports is a real, reachable order count...
      for (const [id, n] of reachable) {
        expect(n).toBeGreaterThan(0);
        const rows = await run(...two(buildEntityLineageQuery(busiest.entity_id, [a, id])));
        expect(rows.length).toBe(n);
      }
      // ...and everything it leaves out really does dead-end.
      for (const id of ring.filter((x) => !reachable.has(x))) {
        const rows = await run(...two(buildEntityLineageQuery(busiest.entity_id, [a, id])));
        expect(rows.length, `${id} was greyed but returns orders`).toBe(0);
      }
    });

    it("asks nothing when there is no ring to ask about", () => {
      expect(buildRingEligibilityQuery("a", [], [])).toBeNull();
    });

    it("caps the orders by how many agencies they name", async () => {
      const all = await run(...two(buildEntityLineageQuery(busiest.entity_id)));
      const small = await run(...two(buildEntityLineageQuery(busiest.entity_id, [], 3)));
      expect(small.length).toBeLessThan(all.length);

      // Every order that survives really does name at most 3 agencies.
      for (const o of small) {
        const [row] = await run(`SELECT agencies FROM eo_agencies WHERE eo_id = ?`, [o.eo_id]);
        expect(Number(row.agencies), o.eo_id).toBeLessThanOrEqual(3);
      }
    });

    it("changes nothing at all when no cap is set", async () => {
      // One query shape serves both cases, so this is what proves the capped
      // path does not quietly alter the default view.
      const flat = (rs) =>
        rs.map(
          (r) => `${r.entity_id}|${r.shared}|${r.eo_count}|${Number(r.affinity).toFixed(9)}`
        );
      const uncapped = await run(
        ...two(buildCooccurrenceQuery(busiest.entity_id, { limit: 10 }))
      );
      const huge = await run(
        ...two(buildCooccurrenceQuery(busiest.entity_id, { limit: 10, maxAgencies: 100000 }))
      );
      expect(flat(uncapped)).toEqual(flat(huge));
    });

    it("counts each agency within the cap, not across the whole corpus", async () => {
      // The subtle one. entities.eo_count is the uncapped total; using it as the
      // denominator under a cap divides a capped numerator by an uncapped total
      // and shrinks every affinity on the page.
      const uncapped = await run(
        ...two(buildCooccurrenceQuery(busiest.entity_id, { limit: 8 }))
      );
      for (const r of uncapped) {
        const [e] = await run(`SELECT eo_count FROM entities WHERE entity_id = ?`, [
          r.entity_id,
        ]);
        expect(Number(r.eo_count)).toBe(Number(e.eo_count));
      }

      const capped = await run(
        ...two(buildCooccurrenceQuery(busiest.entity_id, { limit: 8, maxAgencies: 4 }))
      );
      for (const r of capped) {
        const [e] = await run(
          `SELECT count(*) AS n FROM eo_entity o
           JOIN eo_agencies a ON a.eo_id = o.eo_id AND a.agencies <= 4
           WHERE o.entity_id = ?`,
          [r.entity_id]
        );
        expect(Number(r.eo_count), r.entity_id).toBe(Number(e.n));
        // Still a real share, and still consistent with its own parts.
        expect(Number(r.affinity)).toBeGreaterThan(0);
        expect(Number(r.affinity)).toBeLessThanOrEqual(1);
      }
    });

    it("caps the year strip and the greying too, so nothing contradicts", async () => {
      const orders = await run(...two(buildEntityLineageQuery(busiest.entity_id, [], 5)));
      const years = await run(...two(buildEntityYearsQuery(busiest.entity_id, [], 5)));
      expect(years.reduce((n, r) => n + Number(r.n), 0)).toBe(orders.length);

      const ring = (
        await run(
          ...two(buildCooccurrenceQuery(busiest.entity_id, { limit: 12, maxAgencies: 5 }))
        )
      ).map((r) => r.entity_id);
      const [a] = ring;
      const q = buildRingEligibilityQuery(busiest.entity_id, [a], ring, 5);
      for (const r of await run(q.sql, q.params)) {
        const rows = await run(
          ...two(buildEntityLineageQuery(busiest.entity_id, [a, r.entity_id], 5))
        );
        expect(rows.length, r.entity_id).toBe(Number(r.n));
      }
    });

    it("names the chips without needing the graph", async () => {
      const ring = (
        await run(...two(buildCooccurrenceQuery(busiest.entity_id, { limit: 2 })))
      ).map((r) => r.entity_id);
      const q = buildEntityNamesQuery(ring);
      const rows = await run(q.sql, q.params);
      expect(rows).toHaveLength(ring.length);
      expect(rows.every((r) => r.display_name)).toBe(true);
      expect(buildEntityNamesQuery([])).toBeNull();
    });

    it("gives the agencies-per-order histogram a 0 column", async () => {
      // The whole reason the query LEFT JOINs from eo_meta. eo_agencies has no
      // row for an order that names nothing, so a plain GROUP BY over it reports
      // a distribution with its zero cut off -- a chart that says every order
      // names at least one agency, which is false.
      const rows = await run(buildAgencyHistogramQuery());
      const zero = rows.find((r) => Number(r.bucket) === 0);
      expect(zero, "no 0 column").toBeDefined();
      expect(Number(zero.n)).toBeGreaterThan(0);

      const [{ orders }] = await run(`SELECT count(*) AS orders FROM eo_meta`);
      const counted = rows.reduce((sum, r) => sum + Number(r.n), 0);
      expect(counted).toBe(Number(orders));

      const [{ missing }] = await run(
        `SELECT count(*) AS missing FROM eo_meta m
         LEFT JOIN eo_agencies a ON a.eo_id = m.eo_id
         WHERE a.eo_id IS NULL`
      );
      expect(Number(zero.n)).toBe(Number(missing));
    });

    it("folds the long tail into the last bucket and nothing past it", async () => {
      const rows = await run(buildAgencyHistogramQuery());
      const buckets = rows.map((r) => Number(r.bucket));
      expect(Math.max(...buckets)).toBeLessThanOrEqual(AGENCY_TAIL);

      const [{ n }] = await run(
        `SELECT count(*) AS n FROM eo_agencies WHERE agencies >= ${AGENCY_TAIL}`
      );
      const tail = rows.find((r) => Number(r.bucket) === AGENCY_TAIL);
      expect(Number(tail.n)).toBe(Number(n));
    });

    it("counts each agency once however often an order repeats its name", async () => {
      // eo_agencies is built off eo_entity, which has already collapsed the
      // repeats. A histogram over raw mentions would be a different chart with
      // the same title.
      const [{ mentions }] = await run(
        `SELECT count(*) AS mentions FROM entity_mentions WHERE eo_id = ?`,
        [busiestOrder]
      );
      const [{ agencies }] = await run(`SELECT agencies FROM eo_agencies WHERE eo_id = ?`, [
        busiestOrder,
      ]);
      expect(Number(agencies)).toBeLessThan(Number(mentions));
      const [{ distinct }] = await run(
        `SELECT count(DISTINCT entity_id) AS distinct FROM entity_mentions WHERE eo_id = ?`,
        [busiestOrder]
      );
      expect(Number(agencies)).toBe(Number(distinct));
    });

    it("quotes caption numbers the histogram itself agrees with", async () => {
      const [stats] = await run(buildAgencyCountStatsQuery());
      const rows = await run(buildAgencyHistogramQuery());
      const zero = rows.find((r) => Number(r.bucket) === 0);

      expect(Number(stats.none)).toBe(Number(zero.n));
      // The no-text share is a subset of the 0 column, never the whole story and
      // never larger than it.
      expect(Number(stats.none_no_text)).toBeGreaterThan(0);
      expect(Number(stats.none_no_text)).toBeLessThanOrEqual(Number(stats.none));

      const [{ most }] = await run(`SELECT max(agencies) AS most FROM eo_agencies`);
      expect(Number(stats.most)).toBe(Number(most));
      expect(Number(stats.median)).toBeGreaterThan(0);
      expect(Number(stats.median)).toBeLessThan(Number(stats.most));
    });

    async function anyOrderFor(entityId) {
      const [row] = await run(
        `SELECT eo_id FROM eo_entity WHERE entity_id = ? ORDER BY eo_id LIMIT 1`,
        [entityId]
      );
      return row.eo_id;
    }
  });

  /** The builders return one object; `run` takes (sql, params). */
  const two = ({ sql, params }) => [sql, params];
});
