import * as duckdb from "@duckdb/duckdb-wasm";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";

import { flattenPictures, loadPictures } from "../data/pictures.js";
import { dataUrl } from "../paths.js";

/**
 * The DuckDB engine, as a module-scope singleton.
 *
 * Deliberately NOT a React context with a useEffect that instantiates and a
 * cleanup that terminates: that is exactly the shape StrictMode's double-mount
 * destroys (mount -> instantiate; unmount -> terminate; remount -> a second
 * 34 MB instantiation racing a dead worker). Module initialization happens once
 * per page load, entirely outside React's lifecycle, so double-invocation is a
 * no-op. Nothing here ever terminates the worker -- page unload does that.
 */

// Only the `eh` bundle is shipped. `coi` needs COOP/COEP response headers that
// GitHub Pages cannot set, so it would never be selected; `mvp` costs another
// 39 MB to serve browsers that predate WASM exception handling (pre-2022).
// selectBundle's shape requires an `mvp` key, so it points at the eh assets and
// an explicit capability check gates the whole thing.
const BUNDLES = {
  mvp: { mainModule: ehWasm, mainWorker: ehWorker },
  eh: { mainModule: ehWasm, mainWorker: ehWorker },
};

export const PHASES = {
  IDLE: "idle",
  LOADING_ENGINE: "loading-engine",
  LOADING_META: "loading-meta",
  META_READY: "meta-ready",
  LOADING_TEXT: "loading-text",
  READY: "ready",
  ERROR: "error",
};

let snapshot = {
  phase: PHASES.IDLE,
  progress: 0,
  error: null,
  hasText: false,
  hasPictures: false,
  ftsState: "unbuilt", // unbuilt | building | ready | unavailable
};
const listeners = new Set();

let conn = null;
let enginePromise = null;

function emit(patch) {
  // useSyncExternalStore compares snapshots by reference, so this must be a new
  // object every time or React will not re-render.
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((l) => l());
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot() {
  return snapshot;
}

export function getConnection() {
  return conn;
}

async function boot(manifest) {
  const features = await duckdb.getPlatformFeatures();
  if (!features.wasmExceptions) {
    throw new Error(
      "This browser does not support WebAssembly exception handling, which this app requires. Try a browser released after mid-2022."
    );
  }

  emit({ phase: PHASES.LOADING_ENGINE, progress: 0 });
  const bundle = await duckdb.selectBundle(BUNDLES);

  // A classic worker, NOT { type: "module" } -- duckdb-browser-eh.worker.js is
  // an IIFE script. Also no Blob/createObjectURL shim: that workaround exists
  // only for cross-origin (CDN) worker scripts, and we bundle locally, so this
  // URL is same-origin.
  const worker = new Worker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker, (p) => {
    if (p && p.bytesTotal > 0) emit({ progress: p.bytesLoaded / p.bytesTotal });
  });

  await db.open({
    path: ":memory:",
    // Without this, every COUNT(*) and SUM() arrives as a BigInt and any
    // `bigint + number` in formatting code throws a TypeError.
    query: { castBigIntToDouble: true },
    filesystem: {
      reliableHeadRequests: true,
      // If a host or a compressing proxy ignores Range, fall back to a full
      // read: a performance regression rather than a correctness failure.
      allowFullHTTPReads: true,
    },
  });

  conn = await db.connect();

  // eo_meta is ~50 KB and every query touches it, so buffer it whole rather
  // than paying a HEAD + ranged GETs for a file smaller than one TCP window.
  emit({ phase: PHASES.LOADING_META });
  const version = manifest.files["eo_meta.parquet"].sha256.slice(0, 12);
  const metaBytes = await fetchBytes(dataUrl("eo_meta.parquet", version));
  await db.registerFileBuffer("eo_meta.parquet", metaBytes);
  await conn.query(`CREATE TABLE eo_meta AS SELECT * FROM 'eo_meta.parquet'`);

  const edgeBytes = await fetchBytes(dataUrl("supersession_edges.parquet", version));
  await db.registerFileBuffer("supersession_edges.parquet", edgeBytes);
  await conn.query(`CREATE TABLE edges AS SELECT * FROM 'supersession_edges.parquet'`);

  emit({ phase: PHASES.META_READY });
  return { db, conn };
}

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${url} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

// The store owns the manifest once it has been handed one. Consumers deep in
// the tree (the detail view) need to await a lazily-created table without
// having threaded the manifest down to themselves; requiring it as an argument
// is what let a component query eo_text before anything had created it.
let manifest = null;

export function ensureEngine(m) {
  if (m) manifest = m;
  if (!enginePromise) {
    if (!manifest) throw new Error("ensureEngine() needs a manifest on first call");
    enginePromise = boot(manifest).catch((err) => {
      emit({ phase: PHASES.ERROR, error: err });
      enginePromise = null; // allow an explicit, user-triggered retry
      throw err;
    });
  }
  return enginePromise;
}

/**
 * Materialize the full text. Deferred until the user searches or opens an
 * order, because it is ~1 MB and everything serializes onto the single worker.
 *
 * full_text_raw is NULL in the Parquet wherever it was byte-identical to
 * full_text; it is rehydrated here so nothing downstream special-cases it.
 * full_text_lc is a precomputed lowercase copy, which turns the substring
 * search into a `contains()` scan instead of a per-row ILIKE.
 */
let textPromise = null;
export function ensureText() {
  if (!textPromise) {
    textPromise = (async () => {
      const { db } = await ensureEngine();
      emit({ phase: PHASES.LOADING_TEXT });
      const version = manifest.files["eo_text.parquet"].sha256.slice(0, 12);
      const bytes = await fetchBytes(dataUrl("eo_text.parquet", version));
      await db.registerFileBuffer("eo_text.parquet", bytes);
      await conn.query(`
        CREATE TABLE eo_text AS
        SELECT eo_id,
               full_text,
               coalesce(full_text_raw, full_text) AS full_text_raw,
               lower(full_text)                   AS full_text_lc
        FROM 'eo_text.parquet'
      `);
      emit({ phase: PHASES.READY, hasText: true });
    })().catch((err) => {
      emit({ phase: PHASES.ERROR, error: err });
      textPromise = null;
      throw err;
    });
  }
  return textPromise;
}

/**
 * Materialize the picture crops as a table.
 *
 * They arrive as JSON rather than Parquet (the builder writes a nested
 * eo_id -> [crop] map), but the picture gallery wants exactly what SQL is good
 * at -- a join against a search, exact counts, tag facets, ORDER BY, LIMIT. So
 * the map is flattened in JS and handed to DuckDB as a newline-delimited
 * record stream, which it reads far more directly than it unnests a map.
 *
 * Column types are DECLARED, for the same reason the builder declares them:
 * `tag` is NULL for the ~22% of crops the upstream heuristic declined to
 * classify, and a column that is entirely NULL in an early row group is exactly
 * what inference gets wrong.
 */
let picturesPromise = null;
export function ensurePictures() {
  if (!picturesPromise) {
    picturesPromise = (async () => {
      const { db } = await ensureEngine();
      const { by_eo: byEo } = await loadPictures();
      const rows = flattenPictures(byEo);

      if (rows.length === 0) {
        // The side-car has not run, or its manifest joined to nothing. Create
        // the table anyway, with the same schema, so nothing downstream has to
        // special-case an absent table -- the same move build-data.mjs makes
        // for a missing supersession.json.
        await conn.query(`
          CREATE TABLE pictures AS
          SELECT NULL::VARCHAR AS eo_id, NULL::VARCHAR AS image,
                 NULL::VARCHAR AS tag,   NULL::INTEGER AS page
          WHERE false
        `);
      } else {
        await db.registerFileText(
          "pictures.ndjson",
          rows.map((r) => JSON.stringify(r)).join("\n")
        );
        await conn.query(`
          CREATE TABLE pictures AS
          SELECT * FROM read_json('pictures.ndjson',
            format = 'newline_delimited',
            columns = {eo_id: 'VARCHAR', image: 'VARCHAR', tag: 'VARCHAR', page: 'INTEGER'})
        `);
      }
      emit({ hasPictures: true });
    })().catch((err) => {
      // Deliberately NOT emit({ phase: ERROR }) like ensureText does: the text
      // table is load-bearing for search, this one is one tab. Failing it must
      // not take down the app -- the caller catches and reports inline.
      picturesPromise = null;
      throw err;
    });
  }
  return picturesPromise;
}

/**
 * Build the BM25 index. Opt-in, because `fts` is NOT statically linked into
 * duckdb-wasm -- INSTALL fetches ~480 KB from extensions.duckdb.org at runtime.
 * The substring and regex modes need no extension and no network, which is why
 * they are the defaults and this is a deliberate user action.
 */
let ftsPromise = null;
export function ensureFts() {
  if (!ftsPromise) {
    ftsPromise = (async () => {
      await ensureText();
      emit({ ftsState: "building" });
      await conn.query(`INSTALL fts`);
      await conn.query(`LOAD fts`);
      await conn.query(
        `PRAGMA create_fts_index('eo_text', 'eo_id', 'full_text', overwrite = 1)`
      );
      emit({ ftsState: "ready" });
    })().catch((err) => {
      // A failed index is not a failed app: the scan modes still work.
      console.warn("FTS unavailable:", err);
      emit({ ftsState: "unavailable" });
      ftsPromise = null;
    });
  }
  return ftsPromise;
}

/** Run a query and return plain JS row objects. */
export async function query(sql, params) {
  if (!conn) throw new Error("engine not ready");
  const result = params?.length
    ? await (await conn.prepare(sql)).query(...params)
    : await conn.query(sql);
  return result.toArray().map((r) => r.toJSON());
}
