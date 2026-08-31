import { useEffect, useState } from "react";

import { ensureEntities, query } from "../duckdb/store.js";
import {
  AGENCY_TAIL,
  buildAgencyCountStatsQuery,
  buildAgencyHistogramQuery,
} from "../search/sql.js";

/* Two-series categorical pair, validated with the dataviz palette script:
   lightness band, chroma floor, CVD separation (worst adjacent ΔE 23.2 protan),
   normal-vision separation (ΔE 27.3) and contrast vs surface all PASS. */
const C_REGULAR = "#1f77b4";
const C_EMERGENCY = "#b8860b";

/* text_quality is an ORDERED scale (clean → no-text), not identity, so it takes
   a sequential single-hue ramp light→dark rather than categorical hues. */
const QUALITY_ORDER = ["clean", "minor-noise", "needs-review", "no-text"];
const QUALITY_RAMP = {
  clean: "#cfe3f1",
  "minor-noise": "#92c0de",
  "needs-review": "#4f95c6",
  "no-text": "#1f77b4",
};

export default function Analytics({ hasEntities = false }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [asTable, setAsTable] = useState(false);
  const [agencies, setAgencies] = useState(null);
  const [agencyErr, setAgencyErr] = useState(null);
  const [agencyTable, setAgencyTable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [byYear, byQuality, coverage, byMayor] = await Promise.all([
          query(`SELECT year,
                        count(*) FILTER (NOT is_emergency) AS regular,
                        count(*) FILTER (is_emergency)     AS emergency,
                        count(*)                           AS total
                 FROM eo_meta GROUP BY year ORDER BY year`),
          query(`SELECT text_quality AS value, count(*) AS n
                 FROM eo_meta GROUP BY 1`),
          // Test text_quality, NOT char_count: the 67 orders with no recoverable
          // text still carry the 19-character "_No text available_" stub, so
          // `char_count > 0` is true for every record and would report 100%
          // coverage. Overstating coverage is exactly the failure this project
          // exists to avoid.
          query(`SELECT count(*) AS total,
                        count(*) FILTER (text_quality <> 'no-text') AS with_text,
                        count(*) FILTER (title IS NOT NULL)         AS with_title,
                        count(*) FILTER (date_signed IS NOT NULL)   AS with_date
                 FROM eo_meta`),
          query(`SELECT mayor, min(year) AS from_year, max(year) AS to_year, count(*) AS n
                 FROM eo_meta GROUP BY 1 ORDER BY from_year`),
        ]);
        if (!cancelled) setData({ byYear, byQuality, coverage: coverage[0], byMayor });
      } catch (e) {
        if (!cancelled) setErr(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The agency tables are a separate download, and an older data checkout has no
  // mentions at all -- so this panel loads on its own and simply does not appear
  // when `manifest.includes_entities` is false. The rest of the page must not
  // wait on it, which is why it does not join the Promise.all above.
  useEffect(() => {
    if (!hasEntities) return undefined;
    let cancelled = false;
    (async () => {
      try {
        await ensureEntities();
        if (cancelled) return;
        const [buckets, stats] = await Promise.all([
          query(buildAgencyHistogramQuery()),
          query(buildAgencyCountStatsQuery()),
        ]);
        if (!cancelled) setAgencies({ buckets, stats: stats[0] });
      } catch (e) {
        if (!cancelled) setAgencyErr(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasEntities]);

  if (err) return <div className="status err">Could not load analytics: {String(err)}</div>;
  if (!data) return <div className="empty">Loading analytics…</div>;

  const { byYear, byQuality, coverage, byMayor } = data;
  const maxYear = Math.max(...byYear.map((r) => r.total));
  const quality = QUALITY_ORDER.map((k) => ({
    value: k,
    n: byQuality.find((r) => r.value === k)?.n ?? 0,
  })).filter((r) => r.n > 0);
  const maxQuality = Math.max(...quality.map((r) => r.n));

  // Chart geometry. Columns are thin with a 2px surface gap, and the whole plot
  // scrolls horizontally rather than compressing 50+ years into the viewport.
  const BAR = 14;
  const GAP = 2;
  const H = 220;
  const PAD_L = 44;
  const PAD_B = 34;
  const width = PAD_L + byYear.length * (BAR + GAP) + 12;
  const scale = (v) => (v / maxYear) * (H - PAD_B - 10);

  return (
    <>
      <div className="panel">
        <p className="chart-title">Executive orders per year</p>
        <p className="chart-note">
          Regular and emergency orders, {byYear[0]?.year}–{byYear[byYear.length - 1]?.year}.
          Emergency orders are renewed every few days during a declared emergency, which is why
          they dominate recent years.
        </p>
        <div className="legend">
          <span>
            <i className="swatch" style={{ background: C_REGULAR }} /> Regular
          </span>
          <span>
            <i className="swatch" style={{ background: C_EMERGENCY }} /> Emergency
          </span>
          <button
            className="clear"
            style={{ width: "auto", marginLeft: "auto" }}
            onClick={() => setAsTable((v) => !v)}
          >
            {asTable ? "Show chart" : "Show table"}
          </button>
        </div>

        {asTable ? (
          <div className="chartwrap">
            <table
              className="kv"
              style={{ display: "block", maxHeight: 360, overflow: "auto" }}
            >
              <tbody>
                <tr>
                  <th align="left">Year</th>
                  <th align="right">Regular</th>
                  <th align="right">Emergency</th>
                </tr>
                {byYear.map((r) => (
                  <tr key={r.year}>
                    <td>{r.year}</td>
                    <td align="right">{r.regular}</td>
                    <td align="right">{r.emergency}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="chartwrap">
            <svg width={width} height={H} role="img" aria-label="Executive orders per year">
              {[0, 0.5, 1].map((f) => {
                const y = H - PAD_B - f * (H - PAD_B - 10);
                return (
                  <g key={f}>
                    <line x1={PAD_L} x2={width} y1={y} y2={y} stroke="#e6e6e1" />
                    <text x={0} y={y + 4} fontSize="11" fill="#6d6d66">
                      {Math.round(f * maxYear)}
                    </text>
                  </g>
                );
              })}
              {byYear.map((r, i) => {
                const x = PAD_L + i * (BAR + GAP);
                const hEm = scale(r.emergency);
                const hReg = scale(r.regular);
                const yEm = H - PAD_B - hEm;
                // 2px surface gap between stacked segments.
                const yReg = yEm - hReg - (hEm > 0 && hReg > 0 ? 2 : 0);
                return (
                  <g key={r.year}>
                    <title>{`${r.year}: ${r.regular} regular, ${r.emergency} emergency`}</title>
                    {hEm > 0 ? (
                      <rect x={x} y={yEm} width={BAR} height={hEm} rx="2" fill={C_EMERGENCY} />
                    ) : null}
                    {hReg > 0 ? (
                      <rect x={x} y={yReg} width={BAR} height={hReg} rx="2" fill={C_REGULAR} />
                    ) : null}
                    {r.year % 5 === 0 ? (
                      <text
                        x={x + BAR / 2}
                        y={H - PAD_B + 14}
                        fontSize="11"
                        fill="#6d6d66"
                        textAnchor="middle"
                      >
                        {r.year}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </svg>
          </div>
        )}
      </div>

      {hasEntities ? (
        <AgencyHistogram
          data={agencies}
          err={agencyErr}
          asTable={agencyTable}
          onToggle={() => setAgencyTable((v) => !v)}
        />
      ) : null}

      <div className="panel">
        <p className="chart-title">Text quality</p>
        <p className="chart-note">
          How reliable the extracted text is. Everything before ~2002 is scanned images run
          through OCR, so a search that finds nothing may be a data-quality problem rather than
          an absence.
        </p>
        <div className="bars">
          {quality.map((r) => (
            <div className="barrow" key={r.value}>
              <span>{r.value}</span>
              <span className="bartrack">
                <span
                  className="barfill"
                  style={{
                    width: `${(r.n / maxQuality) * 100}%`,
                    background: QUALITY_RAMP[r.value],
                  }}
                />
              </span>
              <span className="barval">{r.n.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <p className="chart-title">Coverage</p>
        <p className="chart-note">
          What share of the {coverage.total.toLocaleString()} orders carry each field. Gaps here
          are documented, not hidden.
        </p>
        {[
          ["Has extracted text", coverage.with_text],
          ["Has a title", coverage.with_title],
          ["Has a signing date", coverage.with_date],
        ].map(([label, n]) => (
          <div className="meter" key={label}>
            <div className="mlabel">
              <span>{label}</span>
              <span>
                {n.toLocaleString()} / {coverage.total.toLocaleString()} (
                {Math.round((n / coverage.total) * 100)}%)
              </span>
            </div>
            <div className="mtrack">
              <div className="mfill" style={{ width: `${(n / coverage.total) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>

      <div className="panel">
        <p className="chart-title">Administrations</p>
        <div className="bars">
          {byMayor.map((r) => (
            <div className="barrow" key={r.mayor}>
              <span>{r.mayor}</span>
              <span style={{ color: "#6d6d66", fontSize: 13 }}>
                {r.from_year}–{r.to_year}
              </span>
              <span className="barval">{r.n.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/**
 * How many agencies one order names.
 *
 * A histogram, not a ranking: the question is the shape of the spread, and the
 * spread is the point. Half the orders name one or two bodies, and a handful of
 * reorganization orders name dozens.
 *
 * One series, so no legend -- the title names it. The column colour is the same
 * blue the year chart already validated against this surface.
 */
function AgencyHistogram({ data, err, asTable, onToggle }) {
  if (err) {
    return (
      <div className="panel">
        <p className="chart-title">Agencies named per order</p>
        <div className="status err">Could not load the agency counts: {String(err)}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="panel">
        <p className="chart-title">Agencies named per order</p>
        <div className="empty">Loading agency counts…</div>
      </div>
    );
  }

  const { buckets, stats } = data;
  const total = buckets.reduce((sum, r) => sum + r.n, 0);
  // Every bucket 0..AGENCY_TAIL gets a column, including the ones the query
  // returned no row for. A gap in a histogram must read as a zero, not as a
  // missing column.
  const columns = Array.from({ length: AGENCY_TAIL + 1 }, (_, b) => ({
    bucket: b,
    n: buckets.find((r) => r.bucket === b)?.n ?? 0,
  }));
  const max = Math.max(...columns.map((r) => r.n));

  const BAR = 20;
  const GAP = 2;
  const H = 240;
  const PAD_L = 44;
  const PAD_B = 48;
  const width = PAD_L + columns.length * (BAR + GAP) + 12;
  const scale = (v) => (v / max) * (H - PAD_B - 10);
  const label = (b) => (b === AGENCY_TAIL ? `${AGENCY_TAIL}+` : String(b));

  return (
    <div className="panel">
      <p className="chart-title">Agencies named per order</p>
      <p className="chart-note">
        How many distinct agencies each of the {total.toLocaleString()} orders names, counted
        once per agency however often the order repeats the name. Confirmed and proposed names
        count the same. The median order names {stats.median}; the largest names{" "}
        {stats.most.toLocaleString()}. The 0 column holds {stats.none.toLocaleString()} orders,
        and {stats.none_no_text.toLocaleString()} of those have no recoverable text at all — the
        scan had nothing to read, so a 0 there is a gap in the data, not a fact about the order.
      </p>
      <div className="legend">
        <button
          className="clear"
          style={{ width: "auto", marginLeft: "auto" }}
          onClick={onToggle}
        >
          {asTable ? "Show chart" : "Show table"}
        </button>
      </div>

      {asTable ? (
        <div className="chartwrap">
          <table className="kv" style={{ display: "block", maxHeight: 360, overflow: "auto" }}>
            <tbody>
              <tr>
                <th align="left">Agencies named</th>
                <th align="right">Orders</th>
              </tr>
              {columns.map((r) => (
                <tr key={r.bucket}>
                  <td>{label(r.bucket)}</td>
                  <td align="right">{r.n.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chartwrap">
          <svg width={width} height={H} role="img" aria-label="Agencies named per order">
            {[0, 0.5, 1].map((f) => {
              const y = H - PAD_B - f * (H - PAD_B - 10);
              return (
                <g key={f}>
                  <line x1={PAD_L} x2={width} y1={y} y2={y} stroke="#e6e6e1" />
                  <text x={0} y={y + 4} fontSize="11" fill="#6d6d66">
                    {Math.round(f * max)}
                  </text>
                </g>
              );
            })}
            {columns.map((r, i) => {
              const x = PAD_L + i * (BAR + GAP);
              const h = scale(r.n);
              return (
                <g key={r.bucket}>
                  <title>{`${label(r.bucket)} agencies: ${r.n.toLocaleString()} orders`}</title>
                  {h > 0 ? (
                    <rect
                      x={x}
                      y={H - PAD_B - h}
                      width={BAR}
                      height={h}
                      rx="2"
                      fill={C_REGULAR}
                    />
                  ) : null}
                  {r.bucket % 5 === 0 || r.bucket === AGENCY_TAIL ? (
                    <text
                      x={x + BAR / 2}
                      y={H - PAD_B + 14}
                      fontSize="11"
                      fill="#6d6d66"
                      textAnchor="middle"
                    >
                      {label(r.bucket)}
                    </text>
                  ) : null}
                </g>
              );
            })}
            <text
              x={PAD_L + (columns.length * (BAR + GAP)) / 2}
              y={H - 10}
              fontSize="11"
              fill="#6d6d66"
              textAnchor="middle"
            >
              agencies named in one order
            </text>
          </svg>
        </div>
      )}
    </div>
  );
}
