import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import FacetPanel from "./components/FacetPanel.jsx";
import {
  PHASES,
  ensureEngine,
  ensureEntities,
  ensureFts,
  ensurePictures,
  ensureText,
  query,
} from "./duckdb/store.js";
import { useDuckDB } from "./duckdb/useDuckDB.js";
import { dataUrl } from "./paths.js";
import { MODES, buildFacetQuery } from "./search/sql.js";
import { pushHash, readHash } from "./state/hash.js";
import Analytics from "./views/Analytics.jsx";
import Browse from "./views/Browse.jsx";
import Detail from "./views/Detail.jsx";
import Entities from "./views/Entities.jsx";
import Entity from "./views/Entity.jsx";
import Pictures from "./views/Pictures.jsx";

const FACET_KEYS = ["mayor", "text_quality", "source"];

/** The two views that share the search box, the mode toggle and the facet rail. */
const SEARCH_VIEWS = new Set(["browse", "pictures"]);

export default function App() {
  const [state, setState] = useState(() => readHash());
  const [manifest, setManifest] = useState(null);
  const [facetCounts, setFacetCounts] = useState({});
  const [fatal, setFatal] = useState(null);
  const engine = useDuckDB();
  const searchRef = useRef(null);

  // Keep the address bar in sync, and respond to back/forward.
  useEffect(() => pushHash(state), [state]);
  useEffect(() => {
    const onPop = () => setState(readHash());
    window.addEventListener("hashchange", onPop);
    return () => window.removeEventListener("hashchange", onPop);
  }, []);

  // The manifest is tiny and paints the header before the 6.8 MB engine lands.
  useEffect(() => {
    fetch(dataUrl("manifest.json"), { cache: "no-cache" })
      .then((r) => {
        if (!r.ok) throw new Error(`manifest ${r.status}`);
        return r.json();
      })
      .then(setManifest)
      .catch((e) =>
        setFatal(
          `Could not load data/manifest.json (${e.message}). Run \`npm run data\` to build it from the sibling nyc-executive-orders checkout.`
        )
      );
  }, []);

  useEffect(() => {
    if (manifest) ensureEngine(manifest).catch(() => {});
  }, [manifest]);

  // Text is needed for searching and for the detail view, and is deferred until
  // one of those is actually happening.
  const wantsText = Boolean(state.q) || Boolean(state.eo);
  useEffect(() => {
    if (manifest && wantsText && engine.phase !== PHASES.IDLE) {
      ensureText().catch(() => {});
    }
  }, [manifest, wantsText, engine.phase]);

  // The agency tables are wanted by three places: an order (the panel listing
  // who it names), an agency page, and the index. Loaded here rather than in
  // each of them so a deep link straight to #entity=... does not race three
  // separate first calls.
  const wantsEntities = Boolean(state.eo) || Boolean(state.entity) || state.view === "entities";
  useEffect(() => {
    if (manifest?.includes_entities && wantsEntities && engine.phase !== PHASES.IDLE) {
      ensureEntities().catch(() => {});
    }
  }, [manifest, wantsEntities, engine.phase]);

  // The crop table is a JSON fetch plus a CTAS, wanted by exactly one tab and
  // by the facet counts that tab shows, so it loads on arrival there.
  const wantsPictures = state.view === "pictures" && !state.eo;

  const filters = useMemo(
    () => ({
      mayor: state.mayor,
      source: state.source,
      text_quality: state.text_quality,
      yearMin: state.yearMin ?? undefined,
      yearMax: state.yearMax ?? undefined,
      isEmergency: state.isEmergency,
    }),
    [state]
  );

  const metaReady =
    engine.phase === PHASES.META_READY ||
    engine.phase === PHASES.LOADING_TEXT ||
    engine.phase === PHASES.READY;

  useEffect(() => {
    if (metaReady && wantsPictures) ensurePictures().catch(() => {});
  }, [metaReady, wantsPictures]);

  // Facet counts honor every OTHER active filter, so the numbers describe what
  // clicking would actually yield. On the gallery tab that has to include the
  // join to `pictures`, or the rail promises 400 Giuliani orders and delivers
  // no crops -- there are none before 1974's end.
  useEffect(() => {
    if (!metaReady) return;
    if (wantsPictures && !engine.hasPictures) return;
    let cancelled = false;
    (async () => {
      const out = {};
      for (const key of FACET_KEYS) {
        const { sql, params } = buildFacetQuery(key, filters, { pictures: wantsPictures });
        const rows = await query(sql, params);
        out[key] = rows.filter((r) => r.value != null);
      }
      if (!cancelled) setFacetCounts(out);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [metaReady, filters, wantsPictures, engine.hasPictures]);

  const update = useCallback((patch) => setState((s) => ({ ...s, ...patch })), []);
  const clearFilters = useCallback(
    () =>
      setState((s) => ({
        ...s,
        mayor: [],
        source: [],
        text_quality: [],
        picture_tag: [],
        yearMin: null,
        yearMax: null,
        isEmergency: null,
      })),
    []
  );

  const setMode = (mode) => {
    if (mode === MODES.BM25 && manifest) ensureFts();
    update({ mode });
  };

  if (fatal)
    return (
      <div className="app" style={{ padding: 24 }}>
        <div className="status err">{fatal}</div>
      </div>
    );

  const generated = manifest?.generated_at
    ? new Date(manifest.generated_at).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;

  return (
    <div className="app">
      <header className="topbar">
        <h1>NYC Executive Orders</h1>
        {manifest ? (
          <span className="sub">
            {manifest.record_count.toLocaleString()} orders · {manifest.year_min}–
            {manifest.year_max}
            {generated ? ` · data as of ${generated}` : ""}
            {manifest.includes_pre1974 ? "" : " · pre-1974 volumes pending"}
          </span>
        ) : (
          <span className="sub">loading…</span>
        )}
        <nav className="tabs">
          {[
            ["browse", "Search"],
            // "Agencies", not "Entities": the scan finds organizations only --
            // never a person, never a place.
            ...(manifest?.includes_entities ? [["entities", "Agencies"]] : []),
            ["pictures", "Pictures"],
            ["analytics", "Analytics"],
          ].map(([v, label]) => (
            <button
              key={v}
              aria-current={state.view === v && !state.eo && !state.entity ? "page" : undefined}
              onClick={() =>
                update({ view: v, eo: null, entity: null, also: [], max_agencies: null })
              }
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <EngineStatus engine={engine} />

      <div className="main">
        {SEARCH_VIEWS.has(state.view) && !state.eo && !state.entity ? (
          <aside className="rail">
            <FacetPanel
              state={state}
              counts={facetCounts}
              onChange={update}
              onClear={clearFilters}
            />
          </aside>
        ) : null}

        <div className="content">
          {!metaReady ? (
            <div className="empty">Starting the query engine…</div>
          ) : state.eo ? (
            <Detail
              eoId={state.eo}
              onOpen={(id) => update({ eo: id })}
              onOpenEntity={(id) => update({ eo: null, entity: id, also: [] })}
              onBack={() => update({ eo: null })}
            />
          ) : state.entity ? (
            <Entity
              entityId={state.entity}
              also={state.also}
              maxAgencies={state.max_agencies}
              // The cap rides along to the next agency, unlike the picks: it is
              // a statement about which orders are worth looking at at all, not
              // about this one agency.
              onOpen={(id) => update({ entity: id, also: [] })}
              onOpenEo={(id) => update({ entity: null, eo: id })}
              onBack={() => update({ entity: null, also: [], view: "entities" })}
              onChange={update}
            />
          ) : state.view === "entities" ? (
            <Entities state={state} onOpen={(id) => update({ entity: id })} onChange={update} />
          ) : state.view === "analytics" ? (
            <Analytics hasEntities={Boolean(manifest?.includes_entities)} />
          ) : state.view === "pictures" ? (
            <>
              {/* Same box, same modes, same `q` in the hash: a search typed on
                  one tab is still there on the other, which is the whole point
                  of the gallery being a tab rather than a separate page. */}
              <SearchBar
                inputRef={searchRef}
                state={state}
                engine={engine}
                update={update}
                setMode={setMode}
                placeholder="Show pictures from orders whose text contains…"
              />
              <Pictures
                state={state}
                filters={filters}
                hasText={engine.hasText}
                hasPictures={engine.hasPictures}
                onOpen={(id) => update({ eo: id })}
                onChange={update}
              />
            </>
          ) : (
            <>
              <SearchBar
                inputRef={searchRef}
                state={state}
                engine={engine}
                update={update}
                setMode={setMode}
                placeholder="Search the full text of every order…"
              />
              <Browse
                state={state}
                filters={filters}
                hasText={engine.hasText}
                onOpen={(id) => update({ eo: id })}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The search box, mode toggle and mode hint, shared by the two tabs that search.
 *
 * Lifted out of the browse branch when the gallery arrived: the two must offer
 * the identical set of modes, because they run the identical predicate, and a
 * copy that fell one mode behind would be a search that quietly means something
 * different depending on which tab you are on.
 */
function SearchBar({ inputRef, state, engine, update, setMode, placeholder }) {
  return (
    <>
      <div className="searchbar">
        <input
          ref={inputRef}
          type="search"
          placeholder={placeholder}
          value={state.q}
          onChange={(e) => update({ q: e.target.value })}
        />
        <div className="modes">
          <button
            aria-pressed={state.mode === MODES.SUBSTRING}
            onClick={() => setMode(MODES.SUBSTRING)}
          >
            Exact
          </button>
          <button
            aria-pressed={state.mode === MODES.REGEX}
            onClick={() => setMode(MODES.REGEX)}
          >
            Regex
          </button>
          <button
            aria-pressed={state.mode === MODES.BM25}
            onClick={() => setMode(MODES.BM25)}
            disabled={engine.ftsState === "unavailable"}
            title={
              engine.ftsState === "unavailable"
                ? "The full-text index could not be loaded"
                : "Ranked relevance. Downloads a DuckDB extension the first time."
            }
          >
            Relevance
            {engine.ftsState === "building" ? " …" : ""}
          </button>
        </div>
      </div>
      <p className="hint">
        {state.mode === MODES.SUBSTRING
          ? 'Exact — finds the characters you type. Use "quotes" for phrases and -word to exclude. Works on rough OCR.'
          : state.mode === MODES.REGEX
            ? "Regex — a regular expression over the raw text, e.g. admin[il1]strat[il1]on to work around OCR errors."
            : "Relevance — ranks by word importance and ignores common words. Best on clean, modern text."}
      </p>
    </>
  );
}

function EngineStatus({ engine }) {
  if (engine.phase === PHASES.ERROR) {
    return (
      <div style={{ padding: "0 20px" }}>
        <div className="status err">{String(engine.error?.message ?? engine.error)}</div>
      </div>
    );
  }
  if (engine.phase === PHASES.LOADING_ENGINE) {
    return (
      <div style={{ padding: "0 20px" }}>
        <div className="status">
          Loading the query engine (about 7 MB, once per visit)…
          <div className="progress">
            <i style={{ width: `${Math.round(engine.progress * 100)}%` }} />
          </div>
        </div>
      </div>
    );
  }
  return null;
}
