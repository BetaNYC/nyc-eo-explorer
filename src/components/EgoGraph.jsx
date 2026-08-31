import { useEffect, useRef } from "react";

import { KIND_LABEL } from "../data/entities.js";

/**
 * One agency at the center, the agencies named alongside it on a ring.
 *
 * Hand-drawn SVG and a fixed layout, for the same reason Analytics.jsx draws its
 * own charts: this is one picture, and a force simulation would cost a
 * dependency to produce a hairball. An ego network has exactly one shape worth
 * drawing -- everything relates to the middle -- so the ring states that
 * directly, and the layout is the same every time the page is opened.
 *
 * Placement is by rank, not by weight, and alternates left and right from the
 * top: the strongest neighbours land where reading starts, and no label ever
 * sits underneath the one before it.
 *
 * The ring is also a control. One click adds an agency to the filter and the
 * orders below narrow to those naming every agency chosen; anything that would
 * narrow the result to nothing greys out BEFORE it is clicked, so a dead end is
 * visible rather than discovered. Two clicks open that agency's own page.
 *
 * Single and double click on the same target need separating, so a click waits
 * CLICK_GRACE ms to see whether a second one follows. Long enough to catch a
 * real double click, short enough that selecting still feels immediate.
 */
const CLICK_GRACE = 220;

/* The two hues already validated for this app in Analytics.jsx. A confirmed
   agency and a proposed one are a categorical pair, not a scale. */
const C_REGISTRY = "#1f77b4";
const C_PROPOSED = "#b8860b";
const C_LINE = "#9a9a92";
const C_TEXT = "#3d3d38";
const C_MUTED = "#6d6d66";
/* An agency that shares no order with everything already chosen. Still drawn,
   because where it sits and how strong it was are still true -- it just cannot
   be added without emptying the result. */
const C_OUT = "#d6d6d0";
const C_OUT_TEXT = "#a3a39c";

/* Wide, not square. The ring is round but the labels are not: a name hangs
   sideways off every node, and at 24 nodes the widest ones run 200px past the
   circle. A square frame clipped them, so the box is wide enough to hold the
   ring plus a full label on each side. */
const VIEW_W = 1120;
const VIEW_H = 620;
const CX = VIEW_W / 2;
const CY = VIEW_H / 2;
const RADIUS = 212; // where the ring sits
const R_CENTER = 30;
const R_MIN = 5;
const R_MAX = 17;
const LABEL_GAP = 12;

/* Only the strongest chords are drawn. 24 nodes allow 276 pairs, and drawing
   them all is a grey smear that hides the spokes rather than adding anything.
   At this cap a real cluster still shows as a thicket and an unrelated pair
   still shows as nothing. */
const MAX_CHORDS = 28;

/**
 * Where every node and line goes. Pure: no DOM, no React, no measurement.
 *
 * Split out so the geometry can be tested directly — that a ring of one does not
 * divide by zero, that no two nodes land on the same point, and that the
 * alternating order really does put rank 1 at the top.
 *
 * @param {Array<{entity_id: string, display_name: string, kind: string,
 *                shared: number, affinity: number}>} neighbours ranked, strongest first
 * @param {Array<{src: string, dst: string, shared: number}>} edges among the ring
 */
export function layout(neighbours, edges = []) {
  const n = neighbours.length;
  if (n === 0) return { nodes: [], chords: [], maxWeight: 0 };

  // Weight drives size only, never position, so a graph reads the same whether
  // its strongest pair shares 4 orders or 400.
  const weights = neighbours.map((d) => Number(d.shared) || 0);
  const maxWeight = Math.max(...weights, 1);

  // Rank 0 at the top, then right, then left, working down both sides. The
  // arithmetic: even ranks take the right half, odd ranks the left.
  const nodes = neighbours.map((d, i) => {
    const side = i % 2 === 0 ? 1 : -1;
    const step = Math.floor(i / 2) + (i % 2 === 0 ? 0 : 1);
    const angle = -Math.PI / 2 + side * ((2 * Math.PI * step) / n);
    const weight = Number(d.shared) || 0;
    return {
      ...d,
      angle,
      x: CX + RADIUS * Math.cos(angle),
      y: CY + RADIUS * Math.sin(angle),
      r: R_MIN + (R_MAX - R_MIN) * Math.sqrt(weight / maxWeight),
      // Which side the label hangs off. A node within a hair of straight up or
      // down gets `middle`, or its text would jut sideways out of the frame.
      anchor:
        Math.abs(Math.cos(angle)) < 0.12 ? "middle" : Math.cos(angle) > 0 ? "start" : "end",
    };
  });

  const at = new Map(nodes.map((node) => [node.entity_id, node]));
  const onRing = edges
    .filter((e) => at.has(e.src) && at.has(e.dst))
    .sort((a, b) => (Number(b.shared) || 0) - (Number(a.shared) || 0))
    .slice(0, MAX_CHORDS);
  const chordMax = Math.max(1, ...onRing.map((e) => Number(e.shared) || 0));
  const chords = onRing.map((e) => {
    const a = at.get(e.src);
    const b = at.get(e.dst);
    const weight = Number(e.shared) || 0;
    return {
      key: `${e.src}~${e.dst}`,
      // Bowed toward the middle rather than straight across, so a chord is
      // never mistaken for a spoke and two chords over the same span stay
      // distinguishable.
      d: `M ${a.x} ${a.y} Q ${CX} ${CY} ${b.x} ${b.y}`,
      weight,
      opacity: 0.18 + 0.42 * (weight / chordMax),
    };
  });

  return { nodes, chords, maxWeight };
}

const color = (kind) => (kind === "proposed" ? C_PROPOSED : C_REGISTRY);

/** Trim a long agency name so the ring's labels do not overrun the frame. */
export function shortLabel(name, limit = 34) {
  const text = String(name ?? "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

export default function EgoGraph({
  center,
  neighbours,
  edges,
  ranking,
  selected,
  reachable,
  onToggle,
  onOpen,
  maxAgencies = null,
}) {
  const { nodes, chords } = layout(neighbours, edges);
  const chosen = new Set(selected ?? []);
  const filtering = chosen.size > 0;

  // One pending single-click at a time. Held in a ref rather than in state:
  // it must survive a re-render without causing one, and a filter change
  // re-renders this whole component.
  const pending = useRef(null);
  useEffect(() => () => clearTimeout(pending.current), []);

  const press = (entityId, isOut) => {
    clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      if (!isOut) onToggle(entityId);
    }, CLICK_GRACE);
  };
  const pressTwice = (entityId) => {
    clearTimeout(pending.current);
    onOpen(entityId);
  };

  /**
   * How one node is drawn. `reachable` is null until the eligibility of the ring
   * is known, and an agency is only greyed once there is an answer -- greying on
   * a missing map would flash the whole ring out on every click.
   */
  const stateOf = (entityId) => {
    if (chosen.has(entityId)) return "in";
    if (!filtering || !reachable) return "open";
    return reachable.get(entityId) > 0 ? "open" : "out";
  };

  if (nodes.length === 0) {
    // Every co-mention is drawn, down to one shared order, so an empty ring has
    // exactly two possible causes. Say which one, and what to do about it --
    // this used to assert the emptiness was "a finding, not a gap" when most of
    // the time it was a threshold the reader could not see or reach.
    const capped = Number.isFinite(maxAgencies) && maxAgencies > 0;
    return (
      <p className="empty">
        {capped
          ? `Nothing to draw while orders naming more than ${maxAgencies} ` +
            `${maxAgencies === 1 ? "agency" : "agencies"} are ignored. Raise the cap, or clear ` +
            `it, to see who ${center.display_name} appears with.`
          : `No order that names ${center.display_name} names any other agency. Every ` +
            `co-mention is drawn here, so this is the corpus, not a threshold.`}
      </p>
    );
  }

  return (
    <div className="chartwrap">
      <svg
        className="egograph"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label={`Agencies named alongside ${center.display_name}`}
      >
        {/* Chords first, so no line is drawn over a node. */}
        <g>
          {chords.map((c) => (
            <path
              key={c.key}
              d={c.d}
              fill="none"
              stroke={C_LINE}
              strokeWidth="1.5"
              /* While filtering, the chords are about pairs nobody asked
                 about. Faded rather than removed, so the picture does not
                 lurch every time an agency is chosen. */
              strokeOpacity={filtering ? c.opacity * 0.3 : c.opacity}
            />
          ))}
        </g>

        <g>
          {nodes.map((d) => (
            <line
              key={`s-${d.entity_id}`}
              x1={CX}
              y1={CY}
              x2={d.x}
              y2={d.y}
              stroke={stateOf(d.entity_id) === "out" ? C_OUT : color(d.kind)}
              strokeWidth={
                (stateOf(d.entity_id) === "in" ? 2.5 : 1) +
                (2.5 * (d.r - R_MIN)) / (R_MAX - R_MIN)
              }
              strokeOpacity={stateOf(d.entity_id) === "in" ? 0.9 : 0.34}
            />
          ))}
        </g>

        {/* The agency the page is about is always in the filter -- an order
            that does not name it does not belong in its own history. */}
        <title>{center.display_name}</title>
        <circle cx={CX} cy={CY} r={R_CENTER} fill={color(center.kind)} />
        <text
          x={CX}
          y={CY + 5}
          textAnchor="middle"
          fontSize="13"
          fontWeight="600"
          fill="#ffffff"
        >
          {center.short_name ?? initials(center.display_name)}
        </text>

        {nodes.map((d) => {
          const labelX =
            d.x +
            (d.anchor === "middle" ? 0 : d.anchor === "start" ? 1 : -1) * (d.r + LABEL_GAP);
          const labelY =
            d.y +
            (d.anchor === "middle" ? (d.y < CY ? -(d.r + LABEL_GAP) : d.r + LABEL_GAP + 8) : 4);
          const at = stateOf(d.entity_id);
          const out = at === "out";
          const left = reachable?.get(d.entity_id);
          return (
            <g
              key={d.entity_id}
              className={`egonode is-${at}`}
              onClick={() => press(d.entity_id, out)}
              onDoubleClick={() => pressTwice(d.entity_id)}
              role="button"
              aria-pressed={at === "in"}
              aria-disabled={out || undefined}
              tabIndex={0}
              onKeyDown={(e) => {
                // Enter and Space filter, matching one click. Shift+Enter opens
                // the agency, because a keyboard has no double click.
                if (e.key === "Enter" && e.shiftKey) {
                  e.preventDefault();
                  onOpen(d.entity_id);
                } else if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (!out) onToggle(d.entity_id);
                }
              }}
            >
              <title>
                {`${d.display_name} — ${KIND_LABEL[d.kind]}. Named in ${d.shared} of the same orders, ` +
                  `${pct(d.affinity)} of every order naming either of them.` +
                  (at === "in"
                    ? " Chosen — click to remove."
                    : out
                      ? " No order names this one and everything already chosen."
                      : filtering
                        ? ` Click to narrow to ${left} orders.`
                        : " Click to filter the orders below; double-click to open it.")}
              </title>
              {at === "in" ? (
                <circle
                  cx={d.x}
                  cy={d.y}
                  r={d.r + 5}
                  fill="none"
                  stroke={color(d.kind)}
                  strokeWidth="2"
                />
              ) : null}
              <circle
                className="dot"
                cx={d.x}
                cy={d.y}
                r={d.r}
                fill={out ? C_OUT : color(d.kind)}
              />
              <text
                x={labelX}
                y={labelY}
                textAnchor={d.anchor}
                fontSize="12"
                fontWeight={at === "in" ? 600 : undefined}
                fill={out ? C_OUT_TEXT : C_TEXT}
              >
                {shortLabel(d.display_name)}
                <tspan fill={out ? C_OUT_TEXT : C_MUTED}>
                  {ranking === "shared" ? `  ${d.shared}` : `  ${pct(d.affinity)}`}
                </tspan>
              </text>
            </g>
          );
        })}
      </svg>

      <div className="legend">
        <span>
          <i className="swatch" style={{ background: C_REGISTRY }} /> {KIND_LABEL.registry}
        </span>
        <span>
          <i className="swatch" style={{ background: C_PROPOSED }} /> {KIND_LABEL.proposed}
        </span>
      </div>
    </div>
  );
}

/** Affinity reads as a share, because that is what it is. */
const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;

/** A fallback for the centre disc when an agency has no acronym. */
export function initials(name) {
  const words = String(name ?? "")
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w) && !/^(of|and|the|for|to|in|on)$/i.test(w));
  return words
    .slice(0, 3)
    .map((w) => w[0].toUpperCase())
    .join("");
}
