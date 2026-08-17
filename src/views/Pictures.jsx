import { useEffect, useMemo, useRef, useState } from "react";

import Lightbox from "../components/Lightbox.jsx";
import { shortLabel } from "../data/labels.js";
import { PICTURE_TAGS, cropUrl, tagKey, tagLabel } from "../data/pictures.js";
import { ensurePictures, ensureText, query } from "../duckdb/store.js";
import { parseQuery } from "../search/parseQuery.js";
import {
  MODES,
  buildPictureCountQuery,
  buildPictureQuery,
  buildPictureTagQuery,
} from "../search/sql.js";

const PAGE = 120;

/**
 * The gallery: every crop belonging to an order the search matched.
 *
 * The detail view answers "what pictures are on this order's pages". This
 * answers the other direction -- "show me the crops from every order that
 * mentions Robert Moses" -- which is the only way the interesting thing in this
 * data, a mayor's signature across a whole term, is visible at all.
 *
 * It shares `q`, the search mode and the rail's facets with the Search tab, so
 * crossing between them keeps the query. The picture-type filter lives here
 * rather than in the rail because it filters crops, not orders, and its values
 * need labelling ("seal" -> "likely city seal") that FacetPanel does not do.
 */
export default function Pictures({ state, filters, hasText, hasPictures, onOpen, onChange }) {
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState(null);
  const [tagCounts, setTagCounts] = useState({});
  const [limit, setLimit] = useState(PAGE);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const openerRef = useRef(null);

  const parsed = useMemo(() => parseQuery(state.q), [state.q]);
  const searching = !parsed.isEmpty;
  const pictureTags = state.picture_tag ?? [];
  const key = JSON.stringify([filters, state.q, state.mode, pictureTags]);

  // A new query means a new first page, or "Show more" from the previous one
  // carries over. Adjusted during render rather than in an effect: an effect
  // would let the fetch below run once with the stale limit and again with the
  // reset one, which is two queries and a visible flash of the wrong page.
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setLimit(PAGE);
    if (lightbox !== null) setLightbox(null);
  }

  useEffect(() => {
    let cancelled = false;
    // Searching needs the text table; browsing every crop does not, so the
    // gallery is usable without pulling the ~1.7 MB of text.
    if (searching && !hasText) return;

    setBusy(true);
    setErr(null);
    (async () => {
      try {
        await ensurePictures();
        if (searching) await ensureText();
        if (cancelled) return;

        const args = { mode: state.mode, parsed, filters: { ...filters, pictureTags } };
        const q = buildPictureQuery({ ...args, limit });
        const c = buildPictureCountQuery(args);
        const t = buildPictureTagQuery(args);
        const [pics, countRows, tagRows] = await Promise.all([
          query(q.sql, q.params),
          query(c.sql, c.params),
          query(t.sql, t.params),
        ]);
        if (cancelled) return;

        setRows(pics);
        setCounts(countRows[0] ?? { n_pictures: 0, n_orders: 0 });
        setTagCounts(Object.fromEntries(tagRows.map((r) => [r.value, r.n])));
      } catch (e) {
        if (!cancelled) setErr(e);
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, limit, hasText, hasPictures, searching]);

  const toggleTag = (value) => {
    const next = pictureTags.includes(value)
      ? pictureTags.filter((v) => v !== value)
      : [...pictureTags, value];
    onChange({ picture_tag: next });
  };

  const openLightbox = (i, e) => {
    openerRef.current = e.currentTarget;
    setLightbox(i);
  };
  const closeLightbox = () => {
    setLightbox(null);
    openerRef.current?.focus();
  };

  if (err) {
    return (
      <div className="status err">
        Query failed: {String(err.message ?? err)}
        {state.mode === MODES.REGEX ? " — check your regular expression." : null}
      </div>
    );
  }

  if (searching && !hasText) {
    return <div className="empty">Loading the text index…</div>;
  }

  const total = Number(counts?.n_pictures ?? 0);
  const orders = Number(counts?.n_orders ?? 0);

  return (
    <>
      {/* Said once, plainly: the tags are shape/size/ink heuristics from the
          clipping side-car, not a model's classification, and a wrong one
          should read as a wrong guess rather than as a fact. */}
      <p className="pics-note">
        Regions the OCR marked as pictures and the text drops — seals, signatures, the odd
        figure — from every order matching your search. Labels are heuristic guesses, not model
        output, and crops only exist for the scanned pre-1974 volumes.
      </p>

      <div className="pictypes modes small">
        <button
          aria-pressed={pictureTags.length === 0}
          onClick={() => onChange({ picture_tag: [] })}
        >
          All types
        </button>
        {PICTURE_TAGS.map((tag) => {
          const k = tagKey(tag);
          return (
            <button key={k} aria-pressed={pictureTags.includes(k)} onClick={() => toggleTag(k)}>
              {tagLabel(tag)}
              <span className="n">{(Number(tagCounts[k]) || 0).toLocaleString()}</span>
            </button>
          );
        })}
      </div>

      <div className="resulthead">
        {busy ? (
          <span>Searching…</span>
        ) : (
          <span>
            <strong>{total.toLocaleString()}</strong> {total === 1 ? "picture" : "pictures"}{" "}
            from <strong>{orders.toLocaleString()}</strong> {orders === 1 ? "order" : "orders"}
            {searching ? " matching" : ""}
            {total > rows.length ? ` · showing first ${rows.length.toLocaleString()}` : ""}
          </span>
        )}
      </div>

      {rows.length === 0 && !busy ? (
        <div className="empty">
          {searching
            ? "No pictures on the pages of any matching order. Note that older orders are OCR'd scans — try a shorter or more distinctive phrase."
            : "No pictures. Run the upstream picture clipper, then `npm run data`."}
        </div>
      ) : null}

      <div className="picgrid">
        {rows.map((p, i) => (
          <figure className="pic" key={`${p.eo_id}/${p.image}`}>
            <button
              className="cropbtn"
              onClick={(e) => openLightbox(i, e)}
              aria-label={`Enlarge ${tagLabel(p.tag)} from ${shortLabel(p)}, volume page ${p.page}`}
            >
              {/* A page of crops is a page of image requests, and most of them
                  are below the fold. */}
              <img
                loading="lazy"
                src={cropUrl(p.image)}
                alt={`${tagLabel(p.tag)}, volume page ${p.page}`}
              />
            </button>
            <figcaption>
              <span className={`badge pic-${p.tag ?? "none"}`}>{tagLabel(p.tag)}</span>
              <span className="muted">p. {p.page}</span>
            </figcaption>
            {/* A real href, so middle-click and copy-link work; the handler is
                what actually navigates. */}
            <a
              className="picorder"
              href={`#eo=${p.eo_id}`}
              onClick={(e) => {
                e.preventDefault();
                onOpen(p.eo_id);
              }}
              title={p.title ?? undefined}
            >
              {shortLabel(p)} <span className="muted">{p.year}</span>
            </a>
          </figure>
        ))}
      </div>

      {total > rows.length && !busy ? (
        <button className="more" onClick={() => setLimit(rows.length + PAGE)}>
          Show {Math.min(PAGE, total - rows.length).toLocaleString()} more
        </button>
      ) : null}

      {lightbox !== null ? (
        <Lightbox
          items={rows}
          index={lightbox}
          onIndex={setLightbox}
          onClose={closeLightbox}
          onOpen={onOpen}
        />
      ) : null}
    </>
  );
}
