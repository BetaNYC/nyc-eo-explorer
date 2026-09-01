import { useEffect, useState } from "react";

import HashLink from "../components/HashLink.jsx";

import {
  KIND_LABEL,
  KIND_PROPOSED,
  KIND_REGISTRY,
  KIND_TITLE,
  classificationLabel,
  kindClass,
} from "../data/entities.js";
import { ensureEntities, query } from "../duckdb/store.js";
import {
  DEFAULT_MIN_ORDERS,
  buildEntityIndexCountQuery,
  buildEntityIndexQuery,
} from "../search/sql.js";

/**
 * Every agency the orders name, most-cited first.
 *
 * Two kinds sit in one list on purpose. Splitting confirmed and proposed into
 * separate tabs would read as two qualities of data, when what they really are
 * is one question — which bodies do these orders talk about — answered by two
 * methods with different reach. The registry cannot name a dissolved agency at
 * all, so the proposed half is where nearly all the history is.
 *
 * The minimum-orders control is set to the same cutoff the scan upstream uses to
 * decide what a person should review. Below it are 2,167 proposed names, most
 * seen once: OCR damage, sentence fragments, and the occasional real one-off
 * body. Turn it down to see them.
 */

const PAGE = 50;

export default function Entities({ state, onOpen, onChange }) {
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [shown, setShown] = useState(PAGE);
  const [err, setErr] = useState(null);

  const q = state.entity_q ?? "";
  const kinds = state.entity_kind ?? [];
  const minOrders = state.entity_min ?? DEFAULT_MIN_ORDERS;
  const hasLineage = state.entity_lineage === true;
  // Serialized once, so the effects below compare a string rather than a fresh
  // array identity on every render.
  const kindKey = kinds.join(",");

  useEffect(() => setShown(PAGE), [q, kindKey, minOrders, hasLineage]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await ensureEntities();
        if (cancelled) return;
        const args = {
          q,
          kinds: kindKey ? kindKey.split(",") : [],
          minOrders,
          hasLineage,
        };
        const [list, counted] = await Promise.all([
          run(buildEntityIndexQuery({ ...args, limit: shown })),
          run(buildEntityIndexCountQuery(args)),
        ]);
        if (cancelled) return;
        setRows(list);
        setTotal(Number(counted[0]?.n ?? 0));
      } catch (e) {
        if (!cancelled) setErr(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [q, kindKey, minOrders, hasLineage, shown]);

  const toggleKind = (kind) =>
    onChange({
      entity_kind: kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind],
    });

  if (err) return <div className="status err">Could not load the agencies: {String(err)}</div>;

  return (
    <>
      <div className="searchbar">
        <input
          type="search"
          placeholder="Find an agency by name, acronym or former name…"
          value={q}
          onChange={(e) => onChange({ entity_q: e.target.value })}
        />
        <div className="modes">
          {[KIND_REGISTRY, KIND_PROPOSED].map((kind) => (
            <button
              key={kind}
              aria-pressed={kinds.includes(kind)}
              title={KIND_TITLE[kind]}
              onClick={() => toggleKind(kind)}
            >
              {KIND_LABEL[kind]}
            </button>
          ))}
        </div>
      </div>
      <p className="hint">
        Agency names found in the text of the orders. <strong>Confirmed</strong> means the name
        matched BetaNYC&rsquo;s agency registry. <strong>Proposed</strong> means it only looks
        like an agency name — which is the only way a body that no longer exists can appear
        here, because the registry lists agencies that are active today.
      </p>
      <p className="hint">
        <strong>Lineage</strong> is a sentence in an order that establishes, renames, transfers,
        merges or abolishes a body. Few agencies have one: most orders reorganize nothing, and
        the Charter and Local Law do this work too and are not in this corpus.
      </p>

      <div className="searchbar">
        <label className="minorders">
          Named in at least
          <input
            type="number"
            min="1"
            max="50"
            value={minOrders}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              onChange({ entity_min: Number.isFinite(n) && n > 0 ? n : null });
            }}
          />
          orders
        </label>
        {/* Off writes null rather than false, so the key leaves the URL when
            the filter is off and a shared link carries only what was chosen. */}
        <div className="modes small">
          <button
            aria-pressed={hasLineage}
            title={
              "Only the agencies an order establishes, renames, transfers, merges " +
              "or abolishes."
            }
            onClick={() => onChange({ entity_lineage: hasLineage ? null : true })}
          >
            Has lineage
          </button>
        </div>
        {minOrders !== DEFAULT_MIN_ORDERS ? (
          <button className="clear" onClick={() => onChange({ entity_min: null })}>
            Reset
          </button>
        ) : null}
      </div>

      {!rows ? (
        <div className="empty">Loading the agencies…</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          No agency matches that.
          {/* A real and common miss, so it is worth naming. The pattern pass
              only proposes phrases built on an agency head-word (Department,
              Office, Board...), so a bare acronym written on its own -- DoITT,
              HPD -- is never proposed as an agency at all. The word is still in
              the orders, and Search will find it. */}
          {q ? (
            <>
              {" "}
              An acronym written on its own is not recorded as an agency name — try{" "}
              <a href={`#q=${encodeURIComponent(q)}`}>searching the full text</a> for it
              instead.
            </>
          ) : null}
        </div>
      ) : (
        <>
          <p className="resulthead">
            {total.toLocaleString()} {total === 1 ? "agency" : "agencies"}
          </p>
          {rows.map((r) => (
            <article className="result" key={r.entity_id}>
              <h3>
                <HashLink href={`#entity=${r.entity_id}`} onOpen={() => onOpen(r.entity_id)}>
                  {r.display_name}
                </HashLink>
                {r.short_name ? <span className="badge">{r.short_name}</span> : null}
                <span className={kindClass(r.kind)} title={KIND_TITLE[r.kind]}>
                  {KIND_LABEL[r.kind]}
                </span>
              </h3>
              <p className="meta">
                {r.eo_count.toLocaleString()} orders · {r.mention_count.toLocaleString()}{" "}
                mentions · {r.first_year}–{r.last_year}
                {r.classification ? ` · ${classificationLabel(r.classification)}` : ""}
                {/* Named on the row, so a reader who turns the filter on can see
                    which fact put each agency in the list. */}
                {r.event_count > 0
                  ? ` · ${r.event_count.toLocaleString()} lineage ${
                      r.event_count === 1 ? "event" : "events"
                    }`
                  : ""}
              </p>
            </article>
          ))}
          {shown < total ? (
            <button className="clear" onClick={() => setShown((n) => n + PAGE)}>
              Show {Math.min(PAGE, total - shown)} more
            </button>
          ) : null}
        </>
      )}
    </>
  );
}

const run = ({ sql, params }) => query(sql, params);
