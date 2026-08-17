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
  MODES,
  buildCountQuery,
  buildFacetQuery,
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
});
