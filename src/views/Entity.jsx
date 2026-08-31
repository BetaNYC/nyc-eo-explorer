import { useEffect, useState } from "react";

import EgoGraph from "../components/EgoGraph.jsx";
import {
  KIND_LABEL,
  KIND_PROPOSED,
  KIND_TITLE,
  classificationLabel,
  kindClass,
  otherNames,
} from "../data/entities.js";
import { shortLabel } from "../data/labels.js";
import { ensureEntities, query } from "../duckdb/store.js";
import {
  RANKINGS,
  buildCooccurrenceEdgesQuery,
  buildCooccurrenceQuery,
  buildEntityLineageQuery,
  buildEntityNamesQuery,
  buildEntityQuery,
  buildEntityYearsQuery,
  buildRingEligibilityQuery,
} from "../search/sql.js";

/**
 * One agency: what it is, every order that names it, and who it is named with.
 *
 * The lineage list is the point of the page. An agency's history in this corpus
 * IS the run of orders that mention it, and where that run starts and stops says
 * something real — the Board of Estimate runs 1946 to 1990 and then stops,
 * because it was abolished in 1990.
 *
 * Which is also the limit, and the page says so: executive orders are not the
 * only thing that creates or abolishes an agency. The Charter and Local Law do
 * it too, and neither is in this corpus.
 */

const PAGE = 60;
const RING = 24;

const fmtDate = (d) =>
  d
    ? new Date(d).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      })
    : "—";

const LEVELS = {
  nyc: "New York City",
  nys: "New York State",
  authority: "public authority",
  "bi-state": "bi-state authority",
  pbc: "public benefit corporation",
};

export default function Entity({
  entityId,
  also,
  maxAgencies,
  onOpen,
  onOpenEo,
  onBack,
  onChange,
}) {
  const [row, setRow] = useState(null);
  const [orders, setOrders] = useState(null);
  const [years, setYears] = useState([]);
  const [ring, setRing] = useState(null);
  const [reachable, setReachable] = useState(null);
  const [pickedNames, setPickedNames] = useState(new Map());
  const [ranking, setRanking] = useState(RANKINGS.AFFINITY);
  const [shown, setShown] = useState(PAGE);
  const [asTable, setAsTable] = useState(false);
  const [err, setErr] = useState(null);

  // Serialized, so the effects below compare a string rather than a fresh array
  // identity on every render.
  const alsoKey = (also ?? []).join(",");

  useEffect(() => {
    let cancelled = false;
    setRow(null);
    setRing(null);
    (async () => {
      try {
        await ensureEntities();
        if (cancelled) return;
        const [meta] = await run(buildEntityQuery(entityId));
        if (!cancelled) setRow(meta ?? undefined);
      } catch (e) {
        if (!cancelled) setErr(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entityId]);

  // The orders, the year strip and which agencies are still reachable all
  // depend on the filter, so they move together. Kept apart from the record
  // above so choosing an agency does not blank the header and the graph.
  useEffect(() => {
    if (!row) return;
    let cancelled = false;
    setOrders(null);
    setShown(PAGE);
    const alsoIds = alsoKey ? alsoKey.split(",") : [];
    (async () => {
      try {
        const [lineage, byYear] = await Promise.all([
          run(buildEntityLineageQuery(entityId, alsoIds, maxAgencies)),
          run(buildEntityYearsQuery(entityId, alsoIds, maxAgencies)),
        ]);
        if (cancelled) return;
        setOrders(lineage);
        setYears(byYear);
      } catch (e) {
        if (!cancelled) setErr(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entityId, alsoKey, maxAgencies, row]);

  // The graph re-queries when the ranking changes rather than re-sorting what is
  // already loaded: LIMIT applies after ORDER BY, so the top 24 by lift and the
  // top 24 by shared orders are different sets of agencies.
  useEffect(() => {
    if (!row) return;
    let cancelled = false;
    setRing(null);
    (async () => {
      try {
        const nodes = await run(
          buildCooccurrenceQuery(entityId, { limit: RING, ranking, maxAgencies })
        );
        if (cancelled) return;
        const edgeQuery = buildCooccurrenceEdgesQuery(nodes.map((n) => n.entity_id));
        const edges = edgeQuery ? await run(edgeQuery) : [];
        if (!cancelled) setRing({ nodes, edges });
      } catch (e) {
        if (!cancelled) setErr(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entityId, ranking, maxAgencies, row]);

  // Which ring agencies could still be added. Runs only while filtering: with
  // nothing chosen every agency on the ring is reachable by construction, and
  // asking would be a round trip to be told so.
  useEffect(() => {
    if (!ring) return;
    if (!alsoKey) {
      setReachable(null);
      return;
    }
    let cancelled = false;
    const q = buildRingEligibilityQuery(
      entityId,
      alsoKey.split(","),
      ring.nodes.map((n) => n.entity_id),
      maxAgencies
    );
    if (!q) return;
    (async () => {
      const rows = await run(q);
      if (!cancelled) setReachable(new Map(rows.map((r) => [r.entity_id, Number(r.n)])));
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [entityId, alsoKey, maxAgencies, ring]);

  // Chip labels, looked up from the entities table rather than off the ring:
  // changing the cap rebuilds the ring, and an agency already chosen can drop
  // off it while still being part of the filter.
  useEffect(() => {
    const q = buildEntityNamesQuery(alsoKey ? alsoKey.split(",") : []);
    if (!q) {
      setPickedNames(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      const rows = await run(q);
      if (!cancelled) setPickedNames(new Map(rows.map((r) => [r.entity_id, r.display_name])));
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [alsoKey]);

  if (err) return <div className="status err">{String(err)}</div>;
  if (row === undefined) return <div className="empty">No agency with id {entityId}.</div>;
  if (!row) return <div className="empty">Loading {entityId}…</div>;

  const proposed = row.kind === KIND_PROPOSED;
  const alsoIds = alsoKey ? alsoKey.split(",") : [];
  const capped = Number.isFinite(maxAgencies) && maxAgencies > 0;
  const filtering = alsoIds.length > 0 || capped;
  const nameOf = (id) => pickedNames.get(id) ?? id;

  const toggle = (id) =>
    onChange({
      also: alsoIds.includes(id) ? alsoIds.filter((x) => x !== id) : [...alsoIds, id],
    });
  // Registry alternate and former names for a confirmed agency; for a proposed
  // one there is no registry record, so this holds the other spellings the
  // orders use. Different provenance, so they get different labels below.
  const others = otherNames(row);

  return (
    <div className="detail">
      <button className="back" onClick={onBack}>
        ← Back to agencies
      </button>

      <div className="panel">
        <h2>
          {row.display_name}{" "}
          <span className={kindClass(row.kind)} title={KIND_TITLE[row.kind]}>
            {KIND_LABEL[row.kind]}
          </span>
        </h2>

        {proposed ? (
          <p className="chart-note">
            Matched by pattern, not found in the agency registry. That is expected for a body
            that no longer exists: the registry lists agencies that are active today, so a
            department that was abolished or renamed can appear only this way. It can also mean
            the pattern caught a phrase that is not an agency at all — check the orders below.
          </p>
        ) : null}

        <dl className="kv">
          <dt>Named in</dt>
          <dd>
            {row.eo_count.toLocaleString()} orders · {row.mention_count.toLocaleString()}{" "}
            mentions
            {row.letterhead_count > 0 ? (
              // Said out loud rather than left out. The scan upstream marks the
              // mayoral stationery instead of deleting it, and a reader who
              // knows the office is named at the head of nearly every order
              // deserves to see where that count went.
              // `.kv .muted` renders on its own line under the value.
              <span className="muted">
                {row.letterhead_count.toLocaleString()} more name it on the letterhead at the
                head of the page, which is not counted here.
              </span>
            ) : null}
          </dd>
          <dt>First and last</dt>
          <dd>
            {row.first_year}–{row.last_year}
          </dd>
          {row.short_name ? (
            <>
              <dt>Acronym</dt>
              <dd>{row.short_name}</dd>
            </>
          ) : null}
          {row.classification ? (
            <>
              <dt>Kind of body</dt>
              <dd>
                {classificationLabel(row.classification)}
                {row.government_level
                  ? ` · ${LEVELS[row.government_level] ?? row.government_level}`
                  : ""}
              </dd>
            </>
          ) : null}
          {row.founding_date ? (
            <>
              <dt>Founded</dt>
              <dd>{row.founding_date}</dd>
            </>
          ) : null}
          {others.length > 0 ? (
            <>
              <dt>{proposed ? "Also written" : "Also known as"}</dt>
              <dd>
                {/* Acronyms and former names both live in this list, and the
                    former names are the useful half: the registry records
                    "Office of Emergency Management" against NYCEM and
                    "Department of Education" against NYC Public Schools, which
                    is how an order from 2005 connects to the agency today. */}
                <ul className="names">
                  {others.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
                {proposed ? null : (
                  <span className="muted">
                    Alternate and former names recorded by the agency registry, including ones
                    the orders never use.
                  </span>
                )}
              </dd>
            </>
          ) : null}
          {row.primary_domain ? (
            <>
              <dt>Website</dt>
              <dd>
                <a href={`https://${row.primary_domain}`} target="_blank" rel="noreferrer">
                  {row.primary_domain} ↗
                </a>
              </dd>
            </>
          ) : null}
        </dl>

        {row.description ? (
          <>
            <p className="entity-desc">{row.description}</p>
            {/* The agency's own words, not a summary of them, and the licence
                travels with the text. */}
            <p className="pics-note">
              The agency&rsquo;s own description of itself, captured verbatim by BetaNYC&rsquo;s{" "}
              <a
                href="https://github.com/BetaNYC/ny-gov-web-registry"
                target="_blank"
                rel="noreferrer"
              >
                ny-gov-web-registry
              </a>{" "}
              and licensed CC BY-SA 4.0
              {row.description_source_url ? (
                <>
                  {" "}
                  from{" "}
                  <a href={row.description_source_url} target="_blank" rel="noreferrer">
                    its about page ↗
                  </a>
                </>
              ) : null}
              .
            </p>
          </>
        ) : null}
      </div>

      <div className="panel">
        <p className="chart-title">Named alongside</p>
        <p className="chart-note">
          {ranking === RANKINGS.AFFINITY
            ? "Of every order naming either agency, the share that names both. Ranked this " +
              "way rather than by a plain count so that a large agency named everywhere " +
              "does not top every graph here. Every pair is drawn, down to a single " +
              "shared order."
            : "Agencies named in the most orders alongside this one. A plain count, so the " +
              "biggest agencies rise whether or not they have anything to do with this one."}
          {capped
            ? ` Built from the ${orders ? orders.length.toLocaleString() : "…"} orders naming at most ${maxAgencies} agencies.`
            : " Half the orders name one or two agencies and one names 167 — cap the size to keep" +
              " those few from pairing everything with everything."}
        </p>
        <div className="legend">
          {/* The cap belongs beside the graph because that is what it rescues,
              but it narrows the orders below too -- both are built from the
              same set of orders, and letting them disagree would be worse than
              putting the control in a slightly arguable place. */}
          <label className="minorders">
            Ignore orders naming more than
            <input
              type="number"
              min="2"
              max="200"
              placeholder="any"
              value={capped ? maxAgencies : ""}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                onChange({ max_agencies: Number.isFinite(n) && n >= 2 ? n : null });
              }}
            />
            agencies
          </label>
          {capped ? (
            <button className="clear" onClick={() => onChange({ max_agencies: null })}>
              Any size
            </button>
          ) : null}
          <div className="modes small" style={{ marginLeft: "auto" }}>
            <button
              aria-pressed={ranking === RANKINGS.AFFINITY}
              onClick={() => setRanking(RANKINGS.AFFINITY)}
            >
              Most distinctive
            </button>
            <button
              aria-pressed={ranking === RANKINGS.SHARED}
              onClick={() => setRanking(RANKINGS.SHARED)}
            >
              Most shared
            </button>
          </div>
        </div>
        {!ring ? (
          <p className="empty">Working out who this agency appears with…</p>
        ) : (
          <>
            <EgoGraph
              center={row}
              neighbours={ring.nodes}
              edges={ring.edges}
              ranking={ranking}
              selected={alsoIds}
              reachable={reachable}
              onToggle={toggle}
              onOpen={onOpen}
              maxAgencies={maxAgencies}
            />
            <p className="hint">
              Click an agency to narrow the orders below to those naming it as well. Click more
              to narrow further; anything that would leave no orders at all greys out.
              Double-click to open an agency&rsquo;s own page.
            </p>
          </>
        )}
      </div>

      <div className="panel">
        <div className="texthead">
          <h2>{filtering ? "Orders naming all of these" : "Every order that names it"}</h2>
          <div className="modes small">
            <button aria-pressed={!asTable} onClick={() => setAsTable(false)}>
              Show chart
            </button>
            <button aria-pressed={asTable} onClick={() => setAsTable(true)}>
              Hide chart
            </button>
          </div>
        </div>
        <p className="chart-note">
          The run of orders naming this agency, oldest first. Where it starts and stops is
          evidence, but not proof: the Charter and Local Law also create and abolish agencies,
          and neither is in this corpus. A gap can also be OCR — 285 of the pre-1974 orders are
          marked <em>needs-review</em>, and the scan matches exactly.
        </p>

        {filtering ? (
          <div className="picked">
            {/* The agency the page is about is shown first and cannot be removed:
                the list is its history, so an order that does not name it does
                not belong here whatever else it names. */}
            {alsoIds.length > 0 ? (
              <span
                className="badge kind-fixed"
                title="Always part of the filter — this is its page."
              >
                {row.display_name}
              </span>
            ) : null}
            {alsoIds.map((id) => (
              <button
                key={id}
                className="badge picked-off"
                title="Remove from the filter"
                onClick={() => toggle(id)}
              >
                {nameOf(id)} <span aria-hidden="true">×</span>
                <span className="sr-only">, remove from the filter</span>
              </button>
            ))}
            {capped ? (
              <span className="badge" title="Set beside the graph above.">
                at most {maxAgencies} agencies per order
              </span>
            ) : null}
            <button
              className="clear"
              onClick={() => onChange({ also: [], max_agencies: null })}
            >
              Clear filter
            </button>
          </div>
        ) : null}

        {!asTable ? <YearStrip years={years} /> : null}

        {!orders ? (
          <p className="empty">Loading the orders…</p>
        ) : orders.length === 0 ? (
          <p className="empty">
            {alsoIds.length > 0
              ? "No order names all of these agencies together. Remove one to widen the search."
              : `No order names this agency and at most ${maxAgencies} agencies in total. Raise the cap.`}
          </p>
        ) : (
          <>
            <p className="resulthead">
              {orders.length.toLocaleString()} {orders.length === 1 ? "order" : "orders"}
              {filtering
                ? ` of the ${row.eo_count.toLocaleString()} naming ${row.display_name}`
                : ""}
            </p>
            {orders.slice(0, shown).map((o) => (
              <article className="result" key={o.eo_id}>
                <h3>
                  <a href={`#eo=${o.eo_id}`} onClick={() => onOpenEo(o.eo_id)}>
                    {shortLabel(o)}
                  </a>
                  {o.is_emergency ? <span className="badge">emergency</span> : null}
                  {o.mentions > 1 ? <span className="badge">{o.mentions} mentions</span> : null}
                </h3>
                <p className="meta">
                  {fmtDate(o.date_signed)} · {o.mayor}
                </p>
                {o.title ? <p className="snippet">{o.title}</p> : null}
              </article>
            ))}
            {shown < orders.length ? (
              <button className="clear" onClick={() => setShown((n) => n + PAGE)}>
                Show {Math.min(PAGE, orders.length - shown)} more
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Orders per year, with the mayor of each year named underneath.
 *
 * Empty years are drawn as empty rather than skipped: a run with a hole in it
 * and a run without one look different, and that difference is the interesting
 * part of an agency's history.
 *
 * The mayor band is what turns a bar chart into a history. An agency that is
 * named constantly under one mayor and never again under the next has a story,
 * and no list of dates sorted by year will show it.
 *
 * Same bar geometry as Analytics.jsx, so the two charts in this app read at the
 * same scale, and the same horizontal scroll rather than squeezing 81 years into
 * the viewport.
 */
function YearStrip({ years }) {
  if (!years?.length) return null;
  const first = years[0].year;
  const last = years[years.length - 1].year;
  const byYear = new Map(years.map((y) => [y.year, y]));
  const span = [];
  for (let y = first; y <= last; y += 1) span.push(byYear.get(y) ?? { year: y, n: 0 });

  const max = Math.max(...span.map((y) => y.n), 1);
  const BAR = 14;
  const GAP = 2;
  const H = 168;
  const PAD_B = 52;
  const width = span.length * (BAR + GAP) + 8;
  const x = (i) => i * (BAR + GAP);

  // One band per unbroken run of the same mayor. A year the agency is never
  // named still belongs to whoever was mayor, but this chart only knows the
  // years it has rows for, so a gap simply ends the band.
  const bands = [];
  span.forEach((y, i) => {
    const mayor = y.n > 0 ? byYear.get(y.year)?.mayor : null;
    const open = bands[bands.length - 1];
    if (mayor && open && open.mayor === mayor && open.to === i - 1) open.to = i;
    else if (mayor) bands.push({ mayor, from: i, to: i });
  });

  return (
    <div className="chartwrap">
      <svg
        width={width}
        height={H}
        role="img"
        aria-label={`Orders naming this agency each year, ${first} to ${last}`}
      >
        <line x1={0} x2={width} y1={H - PAD_B} y2={H - PAD_B} stroke="#e6e6e1" />
        {span.map((y, i) => {
          const h = (y.n / max) * (H - PAD_B - 10);
          return (
            <g key={y.year}>
              <title>{`${y.year}: ${y.n} ${y.n === 1 ? "order" : "orders"}`}</title>
              {h > 0 ? (
                <rect x={x(i)} y={H - PAD_B - h} width={BAR} height={h} rx="2" fill="#1f77b4" />
              ) : null}
              {y.year % 10 === 0 ? (
                <text
                  x={x(i) + BAR / 2}
                  y={H - PAD_B + 14}
                  fontSize="11"
                  fill="#6d6d66"
                  textAnchor="middle"
                >
                  {y.year}
                </text>
              ) : null}
            </g>
          );
        })}

        {bands.map((b) => {
          const left = x(b.from);
          const right = x(b.to) + BAR;
          // A band narrower than its own name is left unlabelled rather than
          // having the name spill across its neighbour.
          const room = right - left > b.mayor.length * 6.4;
          return (
            <g key={`${b.mayor}-${b.from}`}>
              <title>{`${b.mayor}, ${span[b.from].year}–${span[b.to].year}`}</title>
              <rect
                x={left}
                y={H - PAD_B + 22}
                width={Math.max(2, right - left - 2)}
                height={6}
                rx="3"
                fill="#c9c9c2"
              />
              {room ? (
                <text
                  x={(left + right) / 2}
                  y={H - PAD_B + 42}
                  fontSize="11"
                  fill="#6d6d66"
                  textAnchor="middle"
                >
                  {b.mayor}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const run = ({ sql, params }) => query(sql, params);
