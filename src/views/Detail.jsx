import { lazy, Suspense, useEffect, useState } from "react";

import { longLabel } from "../data/labels.js";
import { cropUrl, onCropError, picturesFor, tagLabel } from "../data/pictures.js";
import { ensureText, query } from "../duckdb/store.js";
import { renderMarkdown } from "../markdown.js";
import { localPdfUrl } from "../paths.js";

/**
 * pdf.js is ~440 KB of app bundle plus a 1.2 MB worker, for a pane that is off
 * by default and useless without a local checkout of the scans. Split out, so
 * the cost lands on whoever opens it rather than on every page load.
 */
const PdfViewer = lazy(() => import("../components/PdfViewer.jsx"));

const fmtDate = (d) =>
  d
    ? new Date(d).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      })
    : "—";

/**
 * A LIST column does not arrive as a JS array: duckdb-wasm hands back an Arrow
 * Vector (iterable, but no .join()) and @duckdb/node-api a {items} wrapper.
 * This normalizes all three shapes, plus NULL, to a plain array.
 */
const pageList = (v) => (v == null ? [] : Array.from(v.items ?? v));

/**
 * Pre-1974 orders are pages of a bound volume scan, so the source link should
 * land on the order rather than on page 1 of 400. The `#page=` fragment is the
 * PDF open-parameter every browser viewer honours; a viewer that ignores it
 * just opens at the top, which is where the link went before anyway.
 */
const pdfHref = (row) =>
  row.source_page_start
    ? `${row.source_pdf_url}#page=${row.source_page_start}`
    : row.source_pdf_url;

export default function Detail({ eoId, onOpen, onBack }) {
  const [row, setRow] = useState(null);
  const [text, setText] = useState(null);
  const [edges, setEdges] = useState({ out: [], in: [] });
  const [pics, setPics] = useState([]);
  const [err, setErr] = useState(null);
  const [raw, setRaw] = useState(false);
  const [sideBySide, setSideBySide] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPics([]);
    picturesFor(eoId).then((p) => !cancelled && setPics(p));
    return () => {
      cancelled = true;
    };
  }, [eoId]);

  useEffect(() => {
    let cancelled = false;
    setRow(null);
    setText(null);
    (async () => {
      try {
        const [meta] = await query(`SELECT * FROM eo_meta WHERE eo_id = ?`, [eoId]);
        if (cancelled) return;
        setRow(meta ?? undefined);
        if (!meta) return;

        // eo_text is created lazily, so it must be awaited rather than assumed.
        // Deep-linking straight to #eo=... is the case that proves it: nothing
        // has searched yet, so without this the table does not exist and DuckDB
        // raises "Table with name eo_text does not exist".
        await ensureText();
        if (cancelled) return;
        const [textRow] = await query(
          `SELECT full_text, full_text_raw FROM eo_text WHERE eo_id = ?`,
          [eoId]
        );
        if (!cancelled) setText(textRow ?? null);

        // The edge table keeps `verb` and `partial`, which the supersedes /
        // superseded_by arrays on the record drop. Unresolved citations are
        // carried too, so "revoked EO-122 (unresolved)" is shown rather than
        // silently omitted.
        const [out, incoming] = await Promise.all([
          query(
            `SELECT e.*, m.title, m.year FROM edges e
             LEFT JOIN eo_meta m ON m.eo_id = e.target
             WHERE e.actor = ? ORDER BY e.target`,
            [eoId]
          ),
          query(
            `SELECT e.*, m.title, m.year FROM edges e
             LEFT JOIN eo_meta m ON m.eo_id = e.actor
             WHERE e.target = ? ORDER BY e.actor`,
            [eoId]
          ),
        ]);
        if (!cancelled) setEdges({ out, in: incoming });
      } catch (e) {
        if (!cancelled) setErr(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eoId]);

  if (err) return <div className="status err">{String(err)}</div>;
  if (row === undefined) return <div className="empty">No order with id {eoId}.</div>;
  if (!row) return <div className="empty">Loading {eoId}…</div>;

  // Volume-derived (pre-1974) orders only; NULL for every order that has a PDF
  // of its own.
  const pages = pageList(row.source_pages);

  // Every record has a pdf_path, but the file behind it only exists if the data
  // repo is checked out next door and the dev mount is serving -- so the toggle
  // is offered on the path, and the viewer says so plainly if the fetch fails.
  //
  // Unfragmented: pdf.js takes the starting page as a prop and would only have
  // to strip a `#page=` back off. The "open in a new tab" link keeps it, since
  // that one lands in the browser's own viewer.
  const localPdf = localPdfUrl(row.pdf_path);
  const pdfHrefLocal = localPdfUrl(row.pdf_path, row.source_page_start);

  return (
    <div className="detail">
      <button className="back" onClick={onBack}>
        ← Back to results
      </button>
      <div className="panel">
        <h2>{longLabel(row)}</h2>
        <p style={{ marginTop: 0, color: row.title ? undefined : "var(--muted)" }}>
          {row.title ?? <em>No title recorded</em>}
        </p>
        <dl className="kv">
          <dt>Identifier</dt>
          <dd>{row.eo_id}</dd>
          <dt>Signed</dt>
          <dd>{fmtDate(row.date_signed)}</dd>
          <dt>Mayor</dt>
          <dd>{row.mayor}</dd>
          <dt>Text source</dt>
          <dd>
            {row.text_source} ·{" "}
            <span className={`badge q-${row.text_quality}`}>{row.text_quality}</span>
          </dd>
          <dt>Provenance</dt>
          <dd>{row.source}</dd>
          <dt>Pages</dt>
          <dd>{row.page_count}</dd>
          {pages.length > 0 ? (
            <>
              <dt>Volume pages</dt>
              <dd>
                {pages.join(", ")}
                <span style={{ color: "var(--muted)" }}>
                  {row.source_page_total
                    ? ` of ${row.source_page_total} in the scanned volume`
                    : " of the scanned volume"}
                </span>
              </dd>
            </>
          ) : null}
          {row.source_pdf_url ? (
            <>
              <dt>Source PDF</dt>
              <dd>
                <a href={pdfHref(row)} target="_blank" rel="noreferrer">
                  {row.source_page_start
                    ? `original volume, page ${row.source_page_start} ↗`
                    : "original document ↗"}
                </a>
              </dd>
            </>
          ) : null}
        </dl>
      </div>

      {edges.out.length > 0 || edges.in.length > 0 ? (
        <div className="panel">
          <h2>Relationships</h2>
          {edges.out.map((e, i) => (
            <div className="edge" key={`o${i}`}>
              <span className="verb">{e.verb}</span>
              {e.target && e.year ? (
                <a href={`#eo=${e.target}`} onClick={() => onOpen(e.target)}>
                  {e.target}
                </a>
              ) : (
                <span className="unresolved">{e.target} (citation unresolved)</span>
              )}
              {e.partial ? <span className="badge">in part</span> : null}
            </div>
          ))}
          {edges.in.map((e, i) => (
            <div className="edge" key={`i${i}`}>
              <span className="verb">{e.verb} by</span>
              <a href={`#eo=${e.actor}`} onClick={() => onOpen(e.actor)}>
                {e.actor}
              </a>
              {e.partial ? <span className="badge">in part</span> : null}
            </div>
          ))}
        </div>
      ) : null}

      {pics.length > 0 ? (
        <div className="panel">
          <h2>Pictures on these pages</h2>
          {/* Everything the OCR tagged `Picture` is dropped from the text, so
              this is the only place the seals and signatures on the scan are
              visible at all. The seal/signature labels are upstream
              heuristics, not model output -- said plainly, because a wrong one
              should read as a wrong guess and not as a fact. */}
          <p className="pics-note">
            Regions the OCR marked as pictures and the text drops — seals, signatures, the odd
            figure. Labels are heuristic guesses, not model output.
          </p>
          <div className="pics">
            {pics.map((p) => (
              <figure className="pic" key={p.image}>
                <img
                  src={cropUrl(p.image)}
                  alt={`${tagLabel(p.tag)}, volume page ${p.page}`}
                  onError={onCropError}
                />
                <figcaption>
                  <span className={`badge pic-${p.tag ?? "none"}`}>{tagLabel(p.tag)}</span>
                  <span className="muted">p. {p.page}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      ) : null}

      <div className="panel">
        <div className="texthead">
          <h2>Full text</h2>
          {text ? (
            <div className="modes small">
              <button aria-pressed={!raw} onClick={() => setRaw(false)}>
                Rendered
              </button>
              <button aria-pressed={raw} onClick={() => setRaw(true)}>
                Raw
              </button>
            </div>
          ) : null}
          {/* The scan is the record and this text is a transcription of it, so
              reading them side by side is the check that matters -- but it
              halves the width the text gets, so it stays opt-in and off by
              default. */}
          {localPdf ? (
            <div className="modes small">
              <button aria-pressed={!sideBySide} onClick={() => setSideBySide(false)}>
                Text only
              </button>
              <button aria-pressed={sideBySide} onClick={() => setSideBySide(true)}>
                Side by side
              </button>
            </div>
          ) : null}
        </div>
        <div className={sideBySide ? "sxs" : undefined}>
          {!text ? (
            <p className="empty">Loading text…</p>
          ) : raw ? (
            // The raw view matters here: this is OCR output, and anyone checking
            // the transcription against the scan needs the characters as stored,
            // not a rendering of them. full_text_raw is the pre-cleanup text.
            <pre className="fulltext">{text.full_text_raw ?? text.full_text}</pre>
          ) : (
            <div
              className="fulltext markdown"
              // Sanitized by DOMPurify in renderMarkdown -- the corpus contains
              // raw <table> HTML from the OCR pipeline, so it cannot be escaped
              // wholesale, and it is untrusted scan output, so it cannot be
              // trusted either.
              dangerouslySetInnerHTML={{ __html: renderMarkdown(text.full_text) }}
            />
          )}
          {sideBySide && localPdf ? (
            <figure className="pdfpane">
              <Suspense fallback={<p className="empty">Loading the PDF viewer…</p>}>
                <PdfViewer
                  src={localPdf}
                  initialPage={row.source_page_start ?? 1}
                  orderPages={pages}
                  label={`${row.eo_id} source PDF`}
                  sourceUrl={pdfHref(row)}
                />
              </Suspense>
              <figcaption>
                <code>{row.pdf_path}</code>, from the corpus mirror.{" "}
                <a href={pdfHrefLocal} target="_blank" rel="noreferrer">
                  open in a new tab ↗
                </a>
              </figcaption>
            </figure>
          ) : null}
        </div>
      </div>
    </div>
  );
}
