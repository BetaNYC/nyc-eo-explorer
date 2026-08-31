#!/usr/bin/env node
/**
 * Build the Parquet artifacts the explorer queries, from the sibling data repo.
 *
 * Reads (from $EO_CORPUS_DIR, default ../nyc-executive-orders/corpus):
 *   eo.json               - the 1974+ corpus, a JSON array of 2,291 records
 *   eo_pre1974.json       - OPTIONAL. Phase E output; absent while the VLM OCR
 *                           pipeline is still running. Same 23-field shape.
 *   pre1974_provenance.json - OPTIONAL. Sidecar keyed by eo_id, and the only
 *                           place the volume page numbers exist.
 *   supersession.json     - {edges: [...], dangling_citations: [...], ...}
 *   mentions.json         - OPTIONAL. lineage/run_scan.py output: where agency
 *                           names appear in each order, plus the registry record
 *                           for every agency matched.
 *
 * Writes (into public/data/):
 *   eo_meta.parquet            21 locked frontmatter fields + char_count +
 *                              source_page_start / source_pages /
 *                              source_page_total, no text
 *   eo_text.parquet            eo_id + full_text + full_text_raw (NULL when identical)
 *   supersession_edges.parquet flat {actor, target, verb, source, partial}
 *   pictures.json              OPTIONAL input, always written: the Phase E
 *                              picture crops grouped by eo_id. Empty when the
 *                              side-car has not been run.
 *   entity_mentions.parquet    one row per (mention, entity it names), with the
 *                              character offsets into full_text
 *   entities.parquet           one row per agency: what to call it, the registry
 *                              facts where they exist, and its corpus counts
 *   manifest.json              counts, sizes, generated_at, source digests
 *
 * And copies the crops themselves into public/pics/, from $EO_PICS_DIR --
 * default ../nyc-executive-orders/vlm-pics-web, the committed JPEG derivative,
 * falling back to the gitignored source PNGs in vlm-pics/ when a local checkout
 * has those and not the other.
 *
 * The meta/text split is deliberate: the browse + facet + analytics UI paints
 * from the small file, and the multi-MB text is only fetched once the user
 * searches or opens an order.
 *
 *   node scripts/build-data.mjs
 *   node scripts/build-data.mjs --verbose
 *   EO_CORPUS_DIR=/other/corpus node scripts/build-data.mjs
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DuckDBInstance } from "@duckdb/node-api";

import { assertNoPrefixCollision, entityRows, mentionRows } from "./lib/entities.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DEFAULT_CORPUS_DIR = resolve(REPO_ROOT, "..", "nyc-executive-orders", "corpus");
const OUT_DIR = join(REPO_ROOT, "public", "data");

/**
 * The locked corpus record schema, mirroring build_corpus.FRONTMATTER_FIELDS in
 * the data repo (src/nyc_executive_orders/build_corpus.py:86) plus the two text
 * fields. Types are declared explicitly and never inferred: `admin_note` is
 * 100% NULL today, `establishes_entity` and `in_effect` are near-all-NULL, and
 * `number` MUST stay VARCHAR because it holds "001", "23" and "1.37" alike.
 */
const RECORD_COLUMNS = {
  eo_id: "VARCHAR",
  number: "VARCHAR",
  year: "INTEGER",
  is_emergency: "BOOLEAN",
  date_signed: "VARCHAR", // TRY_CAST to DATE below; some are null, none malformed
  mayor: "VARCHAR",
  administration: "VARCHAR",
  admin_note: "VARCHAR",
  title: "VARCHAR",
  source: "VARCHAR",
  source_pdf_url: "VARCHAR",
  pdf_path: "VARCHAR",
  supersedes: "VARCHAR[]",
  superseded_by: "VARCHAR[]",
  establishes_entity: "VARCHAR",
  in_effect: "BOOLEAN",
  text_source: "VARCHAR",
  page_count: "INTEGER",
  text_quality: "VARCHAR",
  dropped_header: "VARCHAR",
  dropped_marks: "VARCHAR[]",
  full_text: "VARCHAR",
  full_text_raw: "VARCHAR",
};

/**
 * Columns carried into eo_meta.parquet, in locked order. `date_signed` becomes
 * a real DATE. The last two are NOT frontmatter: they are joined in from the
 * pre-1974 provenance sidecar (see below) and are NULL for every 1974+ order.
 */
const META_FIELDS = [
  "eo_id",
  "number",
  "year",
  "is_emergency",
  "date_signed",
  "mayor",
  "administration",
  "admin_note",
  "title",
  "source",
  "source_pdf_url",
  "pdf_path",
  "supersedes",
  "superseded_by",
  "establishes_entity",
  "in_effect",
  "text_source",
  "page_count",
  "text_quality",
  "dropped_header",
  "dropped_marks",
  "source_page_start",
  "source_pages",
  "source_page_total",
];

/**
 * One row per agency, in locked order.
 *
 * The first four columns describe the agency as this app knows it; the rest are
 * the registry's own facts, and every one of them is NULL for a proposed agency
 * -- which is most of the table. Declaring them is what keeps the Parquet
 * readable: a column that is entirely NULL through an early row group is
 * precisely what type inference gets wrong.
 *
 * `display_name` is what the page is titled with. For a confirmed agency it is
 * the registry's official name; for a proposed one it is the spelling the orders
 * use most often. `other_names` holds the rest either way.
 */
const ENTITY_COLUMNS = {
  entity_id: "VARCHAR",
  kind: "VARCHAR", // registry | proposed
  display_name: "VARCHAR",
  other_names: "VARCHAR[]",
  name: "VARCHAR", // the registry's official name, NULL when proposed
  short_name: "VARCHAR",
  government_level: "VARCHAR",
  classification: "VARCHAR",
  parent_id: "VARCHAR",
  primary_domain: "VARCHAR",
  status: "VARCHAR",
  founding_date: "VARCHAR", // "1965" and "1965-04-01" both occur; never a DATE
  dissolution_date: "VARCHAR",
  description: "VARCHAR",
  description_source_url: "VARCHAR",
  eo_count: "INTEGER",
  mention_count: "INTEGER", // body only -- the letterhead is counted beside it
  letterhead_count: "INTEGER",
  first_year: "INTEGER",
  last_year: "INTEGER",
};

const columnsSpec = (cols) =>
  "{" +
  Object.entries(cols)
    .map(([k, t]) => `'${k}': '${t}'`)
    .join(", ") +
  "}";

const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * How many pages each bound volume has, keyed by the repo-relative `pdf_path`
 * the corpus records use.
 *
 * Counted from the committed per-page OCR output rather than from the PDFs: the
 * volumes are git-LFS and this script must run without them, and Phase E writes
 * one page_NNNN.json per page including blanks, so the count is the PDF's page
 * count. A volume that has not finished its OCR run has published nothing and
 * is simply absent -- its orders get a NULL total and the pager hides the "of
 * N", rather than being clamped to a wrong maximum.
 */
async function volumePageTotals(corpusDir) {
  const repoRoot = resolve(process.env.EO_REPO_DIR || join(corpusDir, ".."));
  const ocrRoot = join(repoRoot, "sources", "gpp", "volumes", "ocr");
  const totals = new Map();
  let stems;
  try {
    stems = await readdir(ocrRoot, { withFileTypes: true });
  } catch {
    return totals; // no OCR output checked out; every total stays NULL
  }
  for (const stem of stems) {
    if (!stem.isDirectory()) continue;
    const files = await readdir(join(ocrRoot, stem.name));
    const pages = files.filter((f) => /^page_\d+\.json$/.test(f)).length;
    if (pages > 0) totals.set(`sources/gpp/volumes/${stem.name}.pdf`, pages);
  }
  return totals;
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/**
 * The crop tree to build from: the committed JPEG derivative if the data repo
 * has one, else the gitignored source PNGs.
 *
 * Both are keyed by the same manifest, so the only difference downstream is the
 * extension riding in each entry's `image` -- which nothing in the app parses.
 */
function pickPicsDir(corpusDir) {
  const web = join(corpusDir, "..", "vlm-pics-web");
  return existsSync(join(web, "manifest.json")) ? web : join(corpusDir, "..", "vlm-pics");
}

/**
 * Copy the crops into public/, so the built site serves them itself.
 *
 * They used to be reached through a dev-server mount pointed at the sibling
 * checkout, which meant the picture layer existed in dev and nowhere else. At
 * JPEG q85 the whole set is ~53 MB -- small enough to just be part of the site,
 * which is both simpler and cheaper than serving it cross-origin.
 *
 * Only the crops the manifest actually references are copied, so a stale PNG
 * left behind by a retuned clipper run does not ride along into the build.
 */
async function copyCrops(picsDir, images, log) {
  const outDir = join(REPO_ROOT, "public", "pics");
  await rm(outDir, { recursive: true, force: true });
  let copied = 0;
  let bytes = 0;
  let missing = 0;
  for (const image of images) {
    const src = join(picsDir, image);
    if (!existsSync(src)) {
      missing += 1;
      continue;
    }
    const dst = join(outDir, image);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
    bytes += (await stat(src)).size;
    copied += 1;
  }
  log(
    `crops:        ${copied} copied to public/pics/ (${(bytes / 1e6).toFixed(1)} MB)` +
      (missing ? ` -- ${missing} listed in the manifest but absent on disk` : "")
  );
}

async function main(argv) {
  const verbose = argv.includes("--verbose") || argv.includes("-v");
  const corpusDir = resolve(process.env.EO_CORPUS_DIR || DEFAULT_CORPUS_DIR);
  const log = (...a) => console.log(...a);
  const debug = (...a) => verbose && console.log(...a);

  const eoJson = join(corpusDir, "eo.json");
  const pre1974Json = join(corpusDir, "eo_pre1974.json");
  const pageProvJson = join(corpusDir, "pre1974_provenance.json");
  const supersessionJson = join(corpusDir, "supersession.json");
  const mentionsJson = join(corpusDir, "mentions.json");

  if (!existsSync(eoJson)) {
    console.error(
      `ERROR: no corpus at ${eoJson}\n` +
        `This repo expects BetaNYC/nyc-executive-orders checked out as a sibling directory:\n` +
        `  <parent>/nyc-executive-orders/\n  <parent>/nyc-eo-explorer/   <- you are here\n` +
        `Override with EO_CORPUS_DIR=/path/to/corpus`
    );
    return 2;
  }

  // Phase E is still running upstream; these appear and disappear. Optional by design.
  const hasPre1974 = existsSync(pre1974Json);
  const hasPageProv = existsSync(pageProvJson);
  const hasSupersession = existsSync(supersessionJson);
  const hasMentions = existsSync(mentionsJson);
  log(`corpus:       ${corpusDir}`);
  log(`pre-1974:     ${hasPre1974 ? "present" : "absent (Phase E still running upstream)"}`);
  log(`page prov:    ${hasPageProv ? "present" : "absent"}`);
  log(`supersession: ${hasSupersession ? "present" : "absent"}`);
  log(`mentions:     ${hasMentions ? "present" : "absent (run lineage/run_scan.py upstream)"}`);

  await mkdir(OUT_DIR, { recursive: true });

  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  const run = async (sql) => {
    debug(`\n--- SQL ---\n${sql}\n`);
    return conn.run(sql);
  };
  const scalar = async (sql) => {
    const reader = await conn.runAndReadAll(sql);
    return reader.getRows()[0][0];
  };

  // ---- load the corpus (1974+, plus pre-1974 when it exists) -----------------
  const spec = columnsSpec(RECORD_COLUMNS);
  const readOne = (path) =>
    `SELECT * FROM read_json(${sqlStr(path)}, columns=${spec}, format='array', maximum_object_size=67108864)`;

  const sources = [readOne(eoJson)];
  if (hasPre1974) sources.push(readOne(pre1974Json));
  await run(`CREATE TABLE raw AS ${sources.join("\nUNION ALL BY NAME\n")};`);

  const total = Number(await scalar("SELECT count(*) FROM raw"));
  const distinctIds = Number(await scalar("SELECT count(DISTINCT eo_id) FROM raw"));
  if (total !== distinctIds) {
    console.error(`ERROR: eo_id is not unique (${total} rows, ${distinctIds} distinct)`);
    return 1;
  }
  log(`loaded ${total} records`);

  // ---- page provenance (pre-1974 only) --------------------------------------
  // A volume-derived order is a few pages of a 400-page bound scan, so "which
  // page" is the difference between a citation and a shrug. The locked 21-field
  // frontmatter has no room for it by design, so upstream keeps it in a sidecar
  // keyed by eo_id; this joins it back on.
  //
  // `pages` is the authoritative list, not `page_span`: 153 records skip blank
  // versos (1946-EO-D0916 is pages 44, 46, 48, 50), so a first..last range would
  // claim pages the order is not on. source_page_start is pages[0], the page to
  // open the PDF at.
  //
  // Every 1974+ order gets NULL here, and correctly so -- each has a PDF of its
  // own in which it starts on page 1.
  //
  // source_page_total is how many pages the whole volume has, which the detail
  // view's PDF pager needs to say "page 44 of 204" and to know where to stop.
  // It is counted from the committed per-page OCR output (one page_NNNN.json
  // per page, blanks included, so the count is the PDF's page count -- checked
  // against PyMuPDF on the O'Dwyer volume: 204 either way). `page_count` on the
  // record is the ORDER's page count, a different number entirely: for
  // 1946-EO-D0916 it is 4 and this is 204.
  let pageProvCount = 0;
  let provEntries = [];
  if (hasPageProv) {
    provEntries = Object.values(JSON.parse(await readFile(pageProvJson, "utf8")));
    const volumeTotals = await volumePageTotals(corpusDir);
    const rows = provEntries
      .filter((e) => Array.isArray(e.pages) && e.pages.length > 0)
      .map((e) => ({
        eo_id: e.eo_id,
        source_page_start: e.pages[0],
        source_pages: e.pages,
        source_page_total: volumeTotals.get(e.volume?.pdf_path) ?? null,
      }));
    pageProvCount = rows.length;
    const withTotal = rows.filter((r) => r.source_page_total).length;
    log(`volume page totals for ${withTotal}/${rows.length} volume-derived records`);
    const tmp = join(OUT_DIR, ".pageprov.tmp.json");
    await writeFile(tmp, JSON.stringify(rows));
    await run(`
      CREATE TABLE page_prov AS SELECT * FROM read_json(${sqlStr(tmp)}, format='array', columns={
        'eo_id': 'VARCHAR', 'source_page_start': 'INTEGER', 'source_pages': 'INTEGER[]',
        'source_page_total': 'INTEGER'
      });
    `);
    await unlink(tmp);
  } else {
    // The columns exist either way, so the parquet schema does not depend on
    // which optional inputs happened to be on disk at build time.
    await run(
      `CREATE TABLE page_prov (eo_id VARCHAR, source_page_start INTEGER, source_pages INTEGER[],
                               source_page_total INTEGER);`
    );
  }
  log(`page provenance for ${pageProvCount} records`);

  const volumeNoPages = Number(
    await scalar(`SELECT count(*) FROM raw LEFT JOIN page_prov USING (eo_id)
                  WHERE raw.source = 'gpp-volume' AND page_prov.source_page_start IS NULL`)
  );
  if (volumeNoPages > 0)
    console.warn(`WARNING: ${volumeNoPages} volume-derived records have no page provenance`);

  // ---- pictures.json (pre-1974 only) ----------------------------------------
  // The Phase E side-car (scripts/run_picture_clips.py upstream) cuts every
  // region dots.ocr tagged `Picture` back out of the volume PDF -- city seals,
  // mayoral signatures, the odd real figure -- all of which the corpus text
  // throws away. Its manifest is per (volume, page); page provenance is per
  // (eo_id, pages), so the two join on the page and give each order the
  // pictures that were physically on its pages.
  //
  // A page can legitimately belong to two orders (one ends where the next
  // begins), so a crop is attached to every record claiming its page rather
  // than to the first. Crops on index or furniture pages belong to no record
  // and are counted as orphans, not silently dropped.
  //
  // JSON, not Parquet: this is a few hundred KB of pointers the detail view
  // wants whole, and it must survive the crops themselves being absent (the
  // upstream side-car may simply not have been run).
  //
  // `vlm-pics-web/` is the COMMITTED JPEG derivative upstream publishes for
  // exactly this purpose; `vlm-pics/` is the 472 MB of gitignored source PNGs,
  // which only exist on a machine that has run the clipper. Preferring the
  // former is what lets a CI checkout of the data repo build a complete site,
  // and the fallback is what keeps a local dev box working before anyone has
  // run build_web_crops.py. Both carry the same manifest shape.
  const picsDir = resolve(process.env.EO_PICS_DIR || pickPicsDir(corpusDir));
  const picsManifest = join(picsDir, "manifest.json");
  const hasPics = existsSync(picsManifest);
  const pictures = { by_eo: {}, count: 0, orphaned: 0, volumes: [] };
  if (hasPics) {
    // pdf_path + page is the join key on both sides: the picture manifest
    // records the volume it clipped from as a repo-relative path, and page
    // provenance records the same string under volume.pdf_path.
    const pageOwners = new Map(); // "<pdf_path>#<page>" -> [eo_id, ...]
    for (const e of provEntries) {
      const pdfPath = e.volume?.pdf_path;
      if (!pdfPath) continue;
      for (const page of e.pages ?? []) {
        const key = `${pdfPath}#${page}`;
        if (!pageOwners.has(key)) pageOwners.set(key, []);
        pageOwners.get(key).push(e.eo_id);
      }
    }

    const all = JSON.parse(await readFile(picsManifest, "utf8")).pictures ?? [];
    const volumes = new Set();
    for (const p of all) {
      volumes.add(p.volume);
      const owners = pageOwners.get(`${p.pdf_path}#${p.page}`) ?? [];
      if (owners.length === 0) {
        pictures.orphaned += 1;
        continue;
      }
      // `tag` is a heuristic upstream, not model output -- dots.ocr has one
      // Picture category and no more. Carried through as-is, null included, so
      // "we could not tell" stays distinguishable from "seal".
      const crop = { image: p.image, tag: p.tag ?? null, page: p.page };
      for (const eoId of owners) (pictures.by_eo[eoId] ??= []).push(crop);
      pictures.count += 1;
    }
    for (const crops of Object.values(pictures.by_eo))
      crops.sort((a, b) => a.page - b.page || a.image.localeCompare(b.image));
    pictures.volumes = [...volumes].sort();
    log(
      `pictures:     ${pictures.count} crops on ${Object.keys(pictures.by_eo).length} orders ` +
        `from ${pictures.volumes.length} volumes (${pictures.orphaned} on non-order pages)`
    );
    // What by_eo references, not every crop in the manifest: an orphan sits on
    // a page no order claims, so nothing in the app can ever render it, and
    // shipping it would be dead weight in the site.
    const referenced = new Set();
    for (const crops of Object.values(pictures.by_eo))
      for (const c of crops) referenced.add(c.image);
    await copyCrops(picsDir, referenced, log);
  } else {
    log(`pictures:     absent (no manifest at ${picsManifest})`);
  }
  await writeFile(join(OUT_DIR, "pictures.json"), JSON.stringify(pictures) + "\n");

  // ---- eo_meta.parquet ------------------------------------------------------
  // date_signed becomes a real DATE; char_count lets the UI size a result
  // without pulling the text column.
  const metaSelect = META_FIELDS.map((f) =>
    f === "date_signed" ? "TRY_CAST(date_signed AS DATE) AS date_signed" : f
  ).join(", ");
  // char_count is CAST to INTEGER deliberately: length() returns BIGINT, which
  // arrives in JS as a BigInt and throws on `bigint + number`. The engine is
  // also opened with castBigIntToDouble, but fixing the type at the source
  // keeps the Parquet honest for non-browser consumers too.
  await run(`
    COPY (
      SELECT ${metaSelect}, CAST(length(full_text) AS INTEGER) AS char_count
      FROM raw LEFT JOIN page_prov USING (eo_id)
      ORDER BY year, eo_id
    ) TO ${sqlStr(join(OUT_DIR, "eo_meta.parquet"))} (FORMAT parquet, COMPRESSION zstd);
  `);

  const badDates = Number(
    await scalar(
      "SELECT count(*) FROM raw WHERE date_signed IS NOT NULL AND TRY_CAST(date_signed AS DATE) IS NULL"
    )
  );
  if (badDates > 0)
    console.warn(`WARNING: ${badDates} date_signed values failed to parse as DATE`);

  // ---- eo_text.parquet ------------------------------------------------------
  // full_text_raw is byte-identical to full_text in ~92% of records; storing the
  // duplicate as NULL is a large win. The app coalesces on read.
  await run(`
    COPY (
      SELECT eo_id, full_text,
             CASE WHEN full_text_raw = full_text THEN NULL ELSE full_text_raw END AS full_text_raw
      FROM raw ORDER BY eo_id
    ) TO ${sqlStr(join(OUT_DIR, "eo_text.parquet"))}
      (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 512);
  `);
  // ROW_GROUP_SIZE 512 is load-bearing, not decoration. DuckDB's default is
  // 122,880 rows, so all 2,291 orders would land in ONE row group and a ranged
  // HTTP read would prune nothing -- the whole point of serving this file over
  // range requests. At 512 we get ~5 groups, and because the rows are sorted by
  // eo_id the per-group min/max statistics let a detail-view lookup fetch a
  // single group instead of the whole megabyte.

  // ---- supersession_edges.parquet ------------------------------------------
  // The array columns on the record drop `verb` and `partial`; the edge list keeps them.
  let edgeCount = 0;
  if (hasSupersession) {
    const parsed = JSON.parse(await readFile(supersessionJson, "utf8"));
    const edges = parsed.edges ?? [];
    edgeCount = edges.length;
    const tmp = join(OUT_DIR, ".edges.tmp.json");
    await writeFile(tmp, JSON.stringify(edges));
    await run(`
      COPY (
        SELECT * FROM read_json(${sqlStr(tmp)}, format='array', columns={
          'actor': 'VARCHAR', 'target': 'VARCHAR', 'verb': 'VARCHAR',
          'source': 'VARCHAR', 'partial': 'BOOLEAN'
        }) ORDER BY actor, target
      ) TO ${sqlStr(join(OUT_DIR, "supersession_edges.parquet"))} (FORMAT parquet, COMPRESSION zstd);
    `);
    await writeFile(tmp, "");
    const { unlink } = await import("node:fs/promises");
    await unlink(tmp);
  } else {
    await run(`
      COPY (SELECT NULL::VARCHAR AS actor, NULL::VARCHAR AS target, NULL::VARCHAR AS verb,
                   NULL::VARCHAR AS source, NULL::BOOLEAN AS partial WHERE false)
      TO ${sqlStr(join(OUT_DIR, "supersession_edges.parquet"))} (FORMAT parquet, COMPRESSION zstd);
    `);
  }

  // ---- entity_mentions.parquet + entities.parquet ---------------------------
  // Where agency names appear in each order, from `lineage/run_scan.py`
  // upstream. Optional the same way pre-1974 and the crops are: an older
  // checkout of the data repo has no mentions.json, and the agency pages then
  // simply do not appear rather than the build failing.
  //
  // The two upstream passes are folded into ONE key space here, with `kind`
  // saying which found each row -- see scripts/lib/entities.mjs for why both
  // have to be shown. Every column is DECLARED, never inferred: the whole
  // registry half of the entity row is NULL for a proposed agency, and a column
  // that is all-NULL in an early row group is what inference gets wrong. The
  // same argument this file already makes for `admin_note`.
  let entityCount = 0;
  let entityMentionCount = 0;
  if (hasMentions) {
    const payload = JSON.parse(await readFile(mentionsJson, "utf8"));
    assertNoPrefixCollision(payload.agencies ?? []);

    const rows = mentionRows(payload);
    // Both counts come off eo_meta, so an order the corpus does not hold cannot
    // quietly contribute a year -- or a row nothing can ever link to.
    const known = new Map(
      (await (await conn.runAndReadAll("SELECT eo_id, year FROM raw")).getRows()).map(
        ([eoId, year]) => [String(eoId), Number(year)]
      )
    );
    const orphaned = rows.filter((r) => !known.has(r.eo_id));
    const kept = rows.filter((r) => known.has(r.eo_id));
    if (orphaned.length > 0) {
      const ids = [...new Set(orphaned.map((r) => r.eo_id))];
      console.warn(
        `WARNING: ${orphaned.length} mentions name ${ids.length} orders absent from the corpus ` +
          `(${ids.slice(0, 3).join(", ")}${ids.length > 3 ? ", ..." : ""}) -- regenerate ` +
          `corpus/mentions.json against this corpus`
      );
    }

    const entities = entityRows(payload, kept, known);
    entityMentionCount = kept.length;
    entityCount = entities.length;

    const mentionsTmp = join(OUT_DIR, ".entity_mentions.tmp.json");
    await writeFile(mentionsTmp, JSON.stringify(kept));
    await run(`
      COPY (
        SELECT * FROM read_json(${sqlStr(mentionsTmp)}, format='array',
          maximum_object_size=134217728, columns={
          'eo_id': 'VARCHAR', 'entity_id': 'VARCHAR', 'kind': 'VARCHAR',
          'ambiguous': 'BOOLEAN', 'start': 'INTEGER', 'end': 'INTEGER', 'text': 'VARCHAR',
          'in_letterhead': 'BOOLEAN'
        }) ORDER BY eo_id, start, entity_id
      ) TO ${sqlStr(join(OUT_DIR, "entity_mentions.parquet"))} (FORMAT parquet, COMPRESSION zstd);
    `);
    await unlink(mentionsTmp);

    const entitiesTmp = join(OUT_DIR, ".entities.tmp.json");
    await writeFile(entitiesTmp, JSON.stringify(entities));
    await run(`
      COPY (
        SELECT * FROM read_json(${sqlStr(entitiesTmp)}, format='array',
          maximum_object_size=134217728, columns=${columnsSpec(ENTITY_COLUMNS)})
        ORDER BY entity_id
      ) TO ${sqlStr(join(OUT_DIR, "entities.parquet"))} (FORMAT parquet, COMPRESSION zstd);
    `);
    await unlink(entitiesTmp);

    const confirmed = entities.filter((e) => e.kind === "registry").length;
    const letterhead = kept.filter((r) => r.in_letterhead).length;
    log(
      `entities:     ${entityCount} agencies (${confirmed} confirmed against the registry, ` +
        `${entityCount - confirmed} proposed) across ${entityMentionCount} mentions ` +
        `(${letterhead} of them letterhead, kept but not counted)`
    );
  } else {
    // The tables exist either way, so the Parquet schema does not depend on
    // which optional inputs happened to be on disk -- the same move made above
    // for page_prov and for the supersession edges.
    await run(`
      COPY (SELECT * FROM (SELECT NULL::VARCHAR AS eo_id, NULL::VARCHAR AS entity_id,
                   NULL::VARCHAR AS kind, NULL::BOOLEAN AS ambiguous, NULL::INTEGER AS start,
                   NULL::INTEGER AS end, NULL::VARCHAR AS text,
                   NULL::BOOLEAN AS in_letterhead) WHERE false)
      TO ${sqlStr(join(OUT_DIR, "entity_mentions.parquet"))} (FORMAT parquet, COMPRESSION zstd);
    `);
    const nulls = Object.entries(ENTITY_COLUMNS)
      .map(([name, type]) => `NULL::${type} AS "${name}"`)
      .join(", ");
    await run(`
      COPY (SELECT * FROM (SELECT ${nulls}) WHERE false)
      TO ${sqlStr(join(OUT_DIR, "entities.parquet"))} (FORMAT parquet, COMPRESSION zstd);
    `);
    log(`entities:     absent (no mentions.json at ${mentionsJson})`);
  }

  // ---- manifest.json --------------------------------------------------------
  const files = {};
  for (const name of [
    "eo_meta.parquet",
    "eo_text.parquet",
    "supersession_edges.parquet",
    "entity_mentions.parquet",
    "entities.parquet",
  ]) {
    const p = join(OUT_DIR, name);
    files[name] = { bytes: (await stat(p)).size, sha256: await sha256(p) };
  }

  const yearRange = (
    await (await conn.runAndReadAll("SELECT min(year), max(year) FROM raw")).getRows()
  )[0];

  const manifest = {
    generated_at: new Date().toISOString(),
    generator: "scripts/build-data.mjs",
    // The basename only. The full path is whatever local checkout the build ran
    // against, and this file is fetched by the browser on every page load --
    // no reason to publish someone's home directory to do it.
    corpus_dir: basename(corpusDir),
    schema_version: 1,
    record_count: total,
    edge_count: edgeCount,
    includes_pre1974: hasPre1974,
    includes_entities: hasMentions,
    entity_count: entityCount,
    entity_mention_count: entityMentionCount,
    page_provenance_count: pageProvCount,
    picture_count: pictures.count,
    picture_orders: Object.keys(pictures.by_eo).length,
    year_min: Number(yearRange[0]),
    year_max: Number(yearRange[1]),
    meta_fields: META_FIELDS,
    files,
  };
  await writeFile(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  conn.closeSync();

  log("\nWROTE:");
  for (const [name, info] of Object.entries(files)) {
    log(`  ${join(OUT_DIR, name)}  ${(info.bytes / 1048576).toFixed(2)} MB`);
  }
  log(`  ${join(OUT_DIR, "manifest.json")}`);
  log(
    `\n${total} orders (${manifest.year_min}-${manifest.year_max}), ${edgeCount} supersession edges, ` +
      `${entityCount} agencies`
  );
  return 0;
}

process.exit(await main(process.argv.slice(2)));
