/**
 * Parse a search box string into structured terms.
 *
 * Supports: "quoted phrases", -exclusions, and bare terms. Written to degrade
 * rather than throw -- an unbalanced quote is a normal thing for a person to
 * type mid-keystroke, not an error.
 *
 * OCR'd source text and copy-paste from PDFs mean typographic quotes
 * (“ ”) show up constantly; they are treated as ordinary quotes.
 */
const QUOTES = new Set(['"', "“", "”"]);

export function parseQuery(input) {
  const empty = { phrases: [], terms: [], excluded: [], isEmpty: true };
  if (typeof input !== "string") return empty;

  const phrases = [];
  const terms = [];
  const excluded = [];

  let i = 0;
  const s = input;
  while (i < s.length) {
    // Skip whitespace.
    if (/\s/.test(s[i])) {
      i += 1;
      continue;
    }

    let negated = false;
    if (s[i] === "-" && i + 1 < s.length && !/\s/.test(s[i + 1])) {
      negated = true;
      i += 1;
    }

    if (QUOTES.has(s[i])) {
      const open = i;
      i += 1;
      let buf = "";
      while (i < s.length && !QUOTES.has(s[i])) {
        buf += s[i];
        i += 1;
      }
      if (i < s.length) {
        i += 1; // consume the closing quote
      }
      // An unterminated quote is treated as a phrase running to end-of-input,
      // which is what someone mid-typing actually means.
      const value = buf.trim();
      if (value) (negated ? excluded : phrases).push(value);
      if (open === i) i += 1; // defensive: never fail to advance
      continue;
    }

    let buf = "";
    while (i < s.length && !/\s/.test(s[i])) {
      buf += s[i];
      i += 1;
    }
    const value = buf.trim();
    if (value) (negated ? excluded : terms).push(value);
  }

  return {
    phrases,
    terms,
    excluded,
    isEmpty: phrases.length === 0 && terms.length === 0 && excluded.length === 0,
  };
}

/**
 * The literal needles a substring search should look for. Phrases match as
 * typed; bare terms match as substrings too, which is what makes this mode
 * tolerant of OCR damage at word boundaries.
 */
export function needles(parsed) {
  return [...parsed.phrases, ...parsed.terms];
}
