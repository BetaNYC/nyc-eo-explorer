import { lazy, Suspense, useEffect, useState } from "react";

import HashLink from "../components/HashLink.jsx";

import { KIND_LABEL, KIND_TITLE, kindClass, markSegments } from "../data/entities.js";
import { longLabel } from "../data/labels.js";
import { cropUrl, onCropError, picturesFor, tagLabel } from "../data/pictures.js";
import { ensureEntities, ensureText, query } from "../duckdb/store.js";
import { buildEntitiesForEoQuery, buildMentionSpansQuery } from "../search/sql.js";
import { renderMarkdown } from "../markdown.js";
import { localPdfUrl } from "../paths.js";

/**
 * pdf.js is ~440 KB of app bundle plus a 1.2 MB worker, for a pane that is off
 * by default and useless without a local checkout of the scans. Split out, so
 * the cost lands on whoever opens it rather than on every page load.
 */
const PdfViewer = lazy(() => import("../components/PdfViewer.jsx"));

const TEXT_RENDERED = "rendered";
const TEXT_MARKED = "marked";
const TEXT_RAW = "raw";

/** `query()` takes (sql, params); the builders return one object. */
const args = ({ sql, params }) => [sql, params];

/**
 * What a marked span is, for the tooltip.
 *
 * A span can carry more than one id: a name that pins down no single agency
 * names every candidate, and pass two can propose a phrase containing a
 * confirmed name. Both are listed rather than one being chosen.
 */
function namesFor(ids, agencies) {
  const byId = new Map(agencies.map((a) => [a.entity_id, a.display_name]));
  return ids.map((id) => byId.get(id) ?? id).join(" · ");
}

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

export default function Detail({ eoId, onOpen, onOpenEntity, onBack, backLabel }) {
  const [row, setRow] = useState(null);
  const [text, setText] = useState(null);
  const [edges, setEdges] = useState({ out: [], in: [] });
  const [pics, setPics] = useState([]);
  const [agencies, setAgencies] = useState([]);
  const [spans, setSpans] = useState([]);
  const [err, setErr] = useState(null);
  // Three ways to read the same order, not two. "Agencies" had to be its own
  // mode rather than a marking added to Raw: the offsets were recorded against
  // full_text, and full_text_raw is a different string in ~8% of records, where
  // the very same offsets would mark the wrong characters.
  const [textMode, setTextMode] = useState(TEXT_RENDERED);
  const [sideBySide, setSideBySide] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPics([]);
    picturesFor(eoId).then((p) => !cancelled && setPics(p));
    return () => {
      cancelled = true;
    };
  }, [eoId]);

  // Its own effect, and its own catch: the agency tables are optional upstream,
  // and an order must still render every other panel when they are absent.
  useEffect(() => {
    let cancelled = false;
    setAgencies([]);
    setSpans([]);
    (async () => {
      await ensureEntities();
      if (cancelled) return;
      const [named, at] = await Promise.all([
        query(...args(buildEntitiesForEoQuery(eoId))),
        query(...args(buildMentionSpansQuery(eoId))),
      ]);
      if (cancelled) return;
      setAgencies(named);
      setSpans(at);
    })().catch(() => {});
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

  // Against full_text and NEVER full_text_raw. The offsets were recorded on
  // full_text; the raw column is the pre-cleanup text and is a different string
  // in ~8% of records, where the same offsets would mark the wrong characters.
  // So the raw toggle shows full_text when there is anything to mark, and says
  // as much rather than marking the wrong span.
  const marks = text ? markSegments(text.full_text, spans) : [];

  return (
    <div className="detail">
      <button className="back" onClick={onBack}>
        {backLabel ?? "← Back to results"}
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
                <HashLink href={`#eo=${e.target}`} onOpen={() => onOpen(e.target)}>
                  {e.target}
                </HashLink>
              ) : (
                <span className="unresolved">{e.target} (citation unresolved)</span>
              )}
              {e.partial ? <span className="badge">in part</span> : null}
            </div>
          ))}
          {edges.in.map((e, i) => (
            <div className="edge" key={`i${i}`}>
              <span className="verb">{e.verb} by</span>
              <HashLink href={`#eo=${e.actor}`} onOpen={() => onOpen(e.actor)}>
                {e.actor}
              </HashLink>
              {e.partial ? <span className="badge">in part</span> : null}
            </div>
          ))}
        </div>
      ) : null}

      {agencies.length > 0 ? (
        <div className="panel">
          <h2>Agencies named in this order</h2>
          {/* In the order they are first named, so reading this panel tracks
              reading the order. The badge is not decoration: half of these were
              matched against a register of agencies and half are phrases that
              merely look like agency names, and a reader must never have to
              guess which. */}
          <p className="pics-note">
            In the order they appear in the text. <strong>Confirmed</strong> matched
            BetaNYC&rsquo;s agency registry; <strong>Proposed</strong> only looks like an agency
            name and has not been reviewed — which is the only way a body that no longer exists
            can show up, since the registry lists agencies active today.
          </p>
          {agencies.map((a) => (
            <div className="edge" key={a.entity_id}>
              <HashLink
                href={`#entity=${a.entity_id}`}
                onOpen={() => onOpenEntity(a.entity_id)}
              >
                {a.display_name}
              </HashLink>
              <span className={kindClass(a.kind)} title={KIND_TITLE[a.kind]}>
                {KIND_LABEL[a.kind]}
              </span>
              {a.mentions > 1 ? <span className="muted">{a.mentions} mentions</span> : null}
              {a.ambiguous ? (
                <span
                  className="badge"
                  title="This name is used by more than one agency, and the scan refused to pick one. It is shown on every candidate's page."
                >
                  more than one agency
                </span>
              ) : null}
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
              <button
                aria-pressed={textMode === TEXT_RENDERED}
                onClick={() => setTextMode(TEXT_RENDERED)}
              >
                Rendered
              </button>
              {marks.length > 1 ? (
                <button
                  aria-pressed={textMode === TEXT_MARKED}
                  onClick={() => setTextMode(TEXT_MARKED)}
                  title="The cleaned text with every agency name marked where the scan found it."
                >
                  {/* Not "Agencies": that is already the name of a tab, and two
                      controls reading the same but meaning different things is
                      exactly what a screen reader cannot disambiguate. */}
                  Names marked
                </button>
              ) : null}
              <button
                aria-pressed={textMode === TEXT_RAW}
                onClick={() => setTextMode(TEXT_RAW)}
              >
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
          ) : textMode === TEXT_RAW ? (
            // The raw view matters here: this is OCR output, and anyone checking
            // the transcription against the scan needs the characters as stored,
            // not a rendering of them. full_text_raw is the pre-cleanup text.
            <pre className="fulltext">{text.full_text_raw ?? text.full_text}</pre>
          ) : textMode === TEXT_MARKED ? (
            // The scan records where each agency name sits in `full_text` and
            // proves `full_text[start:end] === text` for all 23,504 finds, so
            // this is a slice at known positions rather than a second search of
            // the text.
            //
            // Not offered on the rendered view: that goes through marked and
            // DOMPurify, and lining character offsets up with its output would
            // mean injecting markup into untrusted scan text.
            <pre className="fulltext">
              {marks.map((seg, i) =>
                seg.marked ? (
                  <mark className="mark-agency" key={i} title={namesFor(seg.ids, agencies)}>
                    {seg.text}
                  </mark>
                ) : (
                  <span key={i}>{seg.text}</span>
                )
              )}
            </pre>
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
