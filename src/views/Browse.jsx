import { useEffect, useMemo, useState } from "react";

import HashLink from "../components/HashLink.jsx";
import Snippet from "../components/Snippet.jsx";
import { shortLabel } from "../data/labels.js";
import { ensureText, query } from "../duckdb/store.js";
import { needles, parseQuery } from "../search/parseQuery.js";
import { buildSnippet } from "../search/snippet.js";
import { MODES, buildCountQuery, buildSearchQuery } from "../search/sql.js";

const PAGE = 50;

const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString(undefined, { timeZone: "UTC" }) : null;

export default function Browse({ state, filters, hasText, onOpen }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(null);
  const [snips, setSnips] = useState({});
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState(null);
  const [page, setPage] = useState(0);

  const parsed = useMemo(() => parseQuery(state.q), [state.q]);
  const searching = !parsed.isEmpty;
  const key = JSON.stringify([filters, state.q, state.mode]);

  // A new query or a new filter means a new first page. Adjusted during render
  // rather than in an effect, the same way the gallery resets its limit: an
  // effect would let the fetch below run once at the stale offset and again at
  // the reset one, which is two queries and a visible flash of the wrong page.
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setPage(0);
  }

  useEffect(() => {
    let cancelled = false;
    // Searching needs the text table; browsing does not. Do not block the
    // initial list on the ~1 MB text download.
    if (searching && !hasText) return;

    setBusy(true);
    setErr(null);
    (async () => {
      try {
        // Any query that joins eo_text must await it rather than trusting the
        // `hasText` prop, which is a render-time snapshot and can lag.
        if (searching) await ensureText();
        if (cancelled) return;
        const args = { mode: state.mode, parsed, filters, limit: PAGE, offset: page * PAGE };
        const q = buildSearchQuery(args);
        const c = buildCountQuery(args);
        const [resultRows, countRows] = await Promise.all([
          query(q.sql, q.params),
          query(c.sql, c.params),
        ]);
        if (cancelled) return;
        setRows(resultRows);
        setTotal(countRows[0]?.n ?? 0);

        if (searching && resultRows.length > 0) {
          // Pull text only for the rows on screen, then build excerpts in JS --
          // DuckDB's FTS has no snippet().
          const ids = resultRows.map((r) => r.eo_id);
          const texts = await query(
            `SELECT eo_id, full_text FROM eo_text WHERE eo_id IN (${ids
              .map(() => "?")
              .join(",")})`,
            ids
          );
          if (cancelled) return;
          const stemTolerant = state.mode === MODES.BM25;
          const map = {};
          for (const t of texts) {
            map[t.eo_id] = buildSnippet(t.full_text, needles(parsed), { stemTolerant });
          }
          setSnips(map);
        } else {
          setSnips({});
        }
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
  }, [key, page, hasText, searching]);

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

  // count(*) arrives from DuckDB as a BigInt, which throws on arithmetic with a
  // Number. Widen it once here rather than at each use.
  const n = Number(total ?? 0);
  const pages = Math.max(1, Math.ceil(n / PAGE));
  const first = page * PAGE + 1;
  const last = page * PAGE + rows.length;

  const goto = (next) => {
    setPage(next);
    // A page of results is taller than the viewport, so landing at the bottom
    // of the new page reads as nothing having happened.
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <>
      <div className="resulthead">
        {busy ? (
          <span>Searching…</span>
        ) : (
          <span>
            <strong>{n.toLocaleString()}</strong> {n === 1 ? "order" : "orders"}
            {searching ? " matching" : ""}
            {n > rows.length
              ? ` · showing ${first.toLocaleString()}–${last.toLocaleString()}`
              : ""}
          </span>
        )}
      </div>

      {rows.length === 0 && !busy ? (
        <div className="empty">
          Nothing matched. Note that older orders are OCR&apos;d scans — try a shorter or more
          distinctive phrase.
        </div>
      ) : null}

      {rows.map((r) => (
        <article className="result" key={r.eo_id}>
          <div className="rtop">
            <HashLink className="id" href={`#eo=${r.eo_id}`} onOpen={() => onOpen(r.eo_id)}>
              {shortLabel(r)}
            </HashLink>
            <span className={`title${r.title ? "" : " untitled"}`}>
              {r.title ?? "No title recorded"}
            </span>
            {r.is_emergency ? <span className="badge eeo">emergency</span> : null}
            {r.text_quality !== "clean" ? (
              <span className={`badge q-${r.text_quality}`}>{r.text_quality}</span>
            ) : null}
          </div>
          <div className="meta">
            {r.mayor} · {fmtDate(r.date_signed) ?? `${r.year} (date unknown)`}
            {r.score != null ? ` · score ${r.score.toFixed(2)}` : ""}
          </div>
          <Snippet result={snips[r.eo_id]} />
        </article>
      ))}

      {pages > 1 ? (
        <nav className="pager" aria-label="Result pages">
          <button disabled={page === 0 || busy} onClick={() => goto(page - 1)}>
            ← Previous
          </button>
          <span aria-live="polite">
            Page {(page + 1).toLocaleString()} of {pages.toLocaleString()}
          </span>
          <button disabled={page >= pages - 1 || busy} onClick={() => goto(page + 1)}>
            Next →
          </button>
        </nav>
      ) : null}
    </>
  );
}
