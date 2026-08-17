/**
 * Human labels for an order.
 *
 * The series is read from the identifier's middle segment rather than matched
 * against a known list. The 1974+ era has EO and EEO; the pre-1974 volumes add
 * EM (emergency-era memoranda) and AM, and more may appear as the remaining
 * bound volumes are OCR'd. Anything that hardcodes `EO|EEO` becomes wrong the
 * day a new series lands.
 *
 * `number` is NULL for pre-1974 records that carry no printed number (their
 * identifier is date-derived, e.g. 1973-AM-D0628), so it can never be rendered
 * unguarded.
 */

const SERIES_NAMES = {
  EO: "Executive Order",
  EEO: "Emergency Executive Order",
};

/** Split "1973-AM-D0628" into {year, series, rest}. Tolerant of odd shapes. */
export function parseId(eoId) {
  const parts = String(eoId ?? "").split("-");
  if (parts.length < 3) return { year: null, series: null, rest: String(eoId ?? "") };
  return { year: parts[0], series: parts[1], rest: parts.slice(2).join("-") };
}

/**
 * "UNK" (optionally with a disambiguating suffix, e.g. "UNKf") is the upstream
 * sentinel for an order whose printed number could not be read off the scan.
 * Rendering it verbatim -- "Executive Order No. UNKf" -- reads like a real
 * number and is worse than admitting the number is missing.
 */
const isUnknownNumber = (s) => /^UNK/i.test(String(s ?? ""));

/** The number to display, or null when there genuinely isn't one. */
function displayNumber(row) {
  const { rest } = parseId(row?.eo_id);
  const candidate = row?.number ?? rest;
  return isUnknownNumber(candidate) || !candidate ? null : candidate;
}

/** Short label for a result row, e.g. "EO 40", "EEO 301", "AM D0628". */
export function shortLabel(row) {
  const { series } = parseId(row?.eo_id);
  if (!series) return String(row?.eo_id ?? "");
  const num = displayNumber(row);
  return num ? `${series} ${num}` : `${series} (unnumbered)`;
}

/** Long label for the detail heading, e.g. "Executive Order No. 40". */
export function longLabel(row) {
  const { series } = parseId(row?.eo_id);
  if (!series) return String(row?.eo_id ?? "");
  const num = displayNumber(row);
  // Unknown series: name it plainly rather than inventing an expansion.
  const name = SERIES_NAMES[series] ?? series;
  if (!num) return `${name} (number not recorded)`;
  return SERIES_NAMES[series] ? `${name} No. ${num}` : `${name} ${num}`;
}
