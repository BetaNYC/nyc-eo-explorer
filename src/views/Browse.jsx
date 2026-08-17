import { useEffect, useMemo, useState } from "react";

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

  const parsed = useMemo(() => parseQuery(state.q), [state.q]);
  const searching = !parsed.isEmpty;
  const key = JSON.stringify([filters, state.q, state.mode]);

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
        const args = { mode: state.mode, parsed, filters, limit: PAGE };
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
  }, [key, hasText, searching]);

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

  return (
    <>
      <div className="resulthead">
        {busy ? (
          <span>Searching…</span>
        ) : (
          <span>
            <strong>{(total ?? 0).toLocaleString()}</strong> {total === 1 ? "order" : "orders"}
            {searching ? " matching" : ""}
            {total > rows.length ? ` · showing first ${rows.length}` : ""}
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
            <a
              className="id"
              href={`#eo=${r.eo_id}`}
              onClick={(e) => {
                e.preventDefault();
                onOpen(r.eo_id);
              }}
            >
              {shortLabel(r)}
            </a>
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
    </>
  );
}
