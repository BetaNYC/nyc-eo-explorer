/**
 * Excerpt + highlight, in JS.
 *
 * DuckDB's FTS extension has no snippet() (unlike SQLite FTS5), so excerpts are
 * built client-side over only the rows on screen.
 *
 * Output is an array of {text, hit} segments -- deliberately NOT an HTML
 * string. The corpus is OCR'd text that can contain literal "<script>", so
 * nothing here is ever interpreted as markup and no sanitizer is needed.
 */

const WINDOW = 240;

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * For BM25 the index is stemmed but the stored text is not, so an exact term
 * match would miss the very documents BM25 ranked highest. Matching on a
 * shortened prefix ("administrations" -> "administrat") over-matches on
 * purpose: over-highlighting reads as generous, under-highlighting reads broken.
 */
export function termPattern(term, { stemTolerant = false } = {}) {
  // Cap the prefix at 8 characters, not just `length - 2`: trimming two
  // characters off a long word ("administrations" -> "administratio") is still
  // too specific to reach the sibling forms BM25 actually matched
  // ("administrative"). Eight characters is long enough to stay meaningful and
  // short enough to cover the inflections that share a stem. Floor of 4 keeps
  // short words from degenerating into near-universal matches.
  const core = stemTolerant ? term.slice(0, Math.max(4, Math.min(8, term.length - 2))) : term;
  return new RegExp(escapeRegExp(core), "gi");
}

/** Merge overlapping/adjacent ranges so highlights never nest. */
export function mergeRanges(ranges) {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [sorted[0]];
  for (const [start, end] of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

export function findRanges(text, needles, opts) {
  const ranges = [];
  for (const needle of needles) {
    if (!needle) continue;
    const re = termPattern(needle, opts);
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      ranges.push([m.index, m.index + m[0].length]);
      if (ranges.length > 500) break; // pathological input guard
    }
  }
  return mergeRanges(ranges);
}

/**
 * Choose the window containing the most distinct matches, tie-broken toward the
 * earliest. Falls back to the head of the document when nothing matched, so a
 * result always shows something.
 */
export function chooseWindow(text, ranges, size = WINDOW) {
  if (ranges.length === 0) return [0, Math.min(size, text.length)];

  let best = ranges[0][0];
  let bestCount = 0;
  for (const [start] of ranges) {
    const end = start + size;
    const count = ranges.filter(([s]) => s >= start && s < end).length;
    if (count > bestCount) {
      bestCount = count;
      best = start;
    }
  }
  // Give a little lead-in context before the first hit in the window.
  let from = Math.max(0, best - 40);
  let to = Math.min(text.length, from + size);

  // Snap to whitespace so words are not sliced in half.
  if (from > 0) {
    const ws = text.indexOf(" ", from);
    if (ws !== -1 && ws - from < 20) from = ws + 1;
  }
  if (to < text.length) {
    const ws = text.lastIndexOf(" ", to);
    if (ws !== -1 && to - ws < 20) to = ws;
  }
  return [from, to];
}

/**
 * @returns {{segments: {text: string, hit: boolean}[], truncatedStart: boolean, truncatedEnd: boolean}}
 */
export function buildSnippet(text, needles, opts = {}) {
  const source = typeof text === "string" ? text : "";
  const clean = source.replace(/\s+/g, " ").trim();
  const ranges = findRanges(clean, needles ?? [], opts);
  const [from, to] = chooseWindow(clean, ranges, opts.size ?? WINDOW);
  const slice = clean.slice(from, to);

  const segments = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (end <= from || start >= to) continue;
    const s = Math.max(start, from) - from;
    const e = Math.min(end, to) - from;
    if (s > cursor) segments.push({ text: slice.slice(cursor, s), hit: false });
    segments.push({ text: slice.slice(s, e), hit: true });
    cursor = e;
  }
  if (cursor < slice.length) segments.push({ text: slice.slice(cursor), hit: false });
  if (segments.length === 0) segments.push({ text: slice, hit: false });

  return {
    segments,
    truncatedStart: from > 0,
    truncatedEnd: to < clean.length,
  };
}
