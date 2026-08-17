import { describe, expect, it } from "vitest";

import { needles, parseQuery } from "../src/search/parseQuery.js";

describe("parseQuery", () => {
  it("treats empty and whitespace input as empty", () => {
    expect(parseQuery("").isEmpty).toBe(true);
    expect(parseQuery("   \n\t ").isEmpty).toBe(true);
    expect(parseQuery(null).isEmpty).toBe(true);
    expect(parseQuery(undefined).isEmpty).toBe(true);
  });

  it("keeps a quoted phrase as one term", () => {
    const p = parseQuery('"the commissioner of"');
    expect(p.phrases).toEqual(["the commissioner of"]);
    expect(p.terms).toEqual([]);
  });

  it("splits bare terms on whitespace", () => {
    expect(parseQuery("tenant  housing").terms).toEqual(["tenant", "housing"]);
  });

  it("collects -exclusions separately", () => {
    const p = parseQuery("housing -emergency");
    expect(p.terms).toEqual(["housing"]);
    expect(p.excluded).toEqual(["emergency"]);
  });

  it("handles a negated phrase", () => {
    expect(parseQuery('-"state of emergency"').excluded).toEqual(["state of emergency"]);
  });

  it("accepts typographic quotes, which OCR and copy-paste produce constantly", () => {
    expect(parseQuery("“racial inclusion”").phrases).toEqual(["racial inclusion"]);
  });

  it("degrades on an unbalanced quote instead of throwing", () => {
    // Someone mid-typing has an unbalanced quote on almost every keystroke.
    const p = parseQuery('"the commissioner');
    expect(p.phrases).toEqual(["the commissioner"]);
  });

  it("treats a bare hyphen as text, not as an exclusion marker", () => {
    expect(parseQuery("- foo").terms).toEqual(["-", "foo"]);
  });

  it("preserves punctuation that matters in this corpus", () => {
    expect(parseQuery("§ 3-113.1").terms).toEqual(["§", "3-113.1"]);
  });

  it("never throws on arbitrary input", () => {
    const chars = '"“”- \t\n§&=#\\/*.?[]()';
    for (let i = 0; i < 300; i += 1) {
      let s = "";
      for (let j = 0; j < 12; j += 1) {
        s += chars[(i * 7 + j * 13) % chars.length];
      }
      expect(() => parseQuery(s)).not.toThrow();
    }
  });

  it("needles() flattens phrases and terms but not exclusions", () => {
    expect(needles(parseQuery('"a b" c -d'))).toEqual(["a b", "c"]);
  });
});
