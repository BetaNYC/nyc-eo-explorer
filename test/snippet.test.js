import { describe, expect, it } from "vitest";

import { buildSnippet, mergeRanges, termPattern } from "../src/search/snippet.js";

const text = (s) => s.replace(/\s+/g, " ").trim();
const joined = (r) => r.segments.map((s) => s.text).join("");
const hits = (r) => r.segments.filter((s) => s.hit).map((s) => s.text);

describe("mergeRanges", () => {
  it("merges overlapping ranges so highlights never nest", () => {
    expect(
      mergeRanges([
        [0, 5],
        [3, 8],
        [20, 25],
      ])
    ).toEqual([
      [0, 8],
      [20, 25],
    ]);
  });

  it("returns an empty list unchanged", () => {
    expect(mergeRanges([])).toEqual([]);
  });
});

describe("termPattern", () => {
  it("escapes regex metacharacters in user input", () => {
    expect(termPattern("3-113.1").test("3-113.1")).toBe(true);
    expect(termPattern("a.c").test("abc")).toBe(false);
  });

  it("shortens the needle in stem-tolerant mode", () => {
    // BM25 matches on stems but the stored text is unstemmed, so an exact
    // match would fail to highlight the very documents it ranked highest.
    const re = termPattern("administrations", { stemTolerant: true });
    expect(re.test("administrative")).toBe(true);
  });

  it("never shortens below four characters", () => {
    expect(termPattern("tax", { stemTolerant: true }).source).toContain("tax");
  });
});

describe("buildSnippet", () => {
  const doc = text(`
    THE CITY OF NEW YORK OFFICE OF THE MAYOR
    EXECUTIVE ORDER NO. 12 concerning the Commissioner of Housing
    Preservation and Development and the administration of tenant protections
    across all five boroughs of the city of New York.
  `);

  it("returns a leading excerpt when nothing matched", () => {
    const r = buildSnippet(doc, ["nonexistent"]);
    expect(joined(r).length).toBeGreaterThan(0);
    expect(hits(r)).toEqual([]);
    expect(r.truncatedStart).toBe(false);
  });

  it("highlights an exact match", () => {
    const r = buildSnippet(doc, ["Commissioner"]);
    expect(hits(r)).toContain("Commissioner");
  });

  it("is case-insensitive", () => {
    expect(hits(buildSnippet(doc, ["commissioner"]))).toContain("Commissioner");
  });

  it("does not mark a leading ellipsis when the window starts at zero", () => {
    const r = buildSnippet(doc, ["THE CITY"]);
    expect(r.truncatedStart).toBe(false);
  });

  it("reports truncation when the window is interior", () => {
    const long = "x ".repeat(400) + "needle " + "y ".repeat(400);
    const r = buildSnippet(long, ["needle"]);
    expect(r.truncatedStart).toBe(true);
    expect(r.truncatedEnd).toBe(true);
    expect(hits(r)).toContain("needle");
  });

  it("returns segments as data, never as markup", () => {
    // The corpus is OCR'd text. A document containing a literal <script> tag
    // must come back as text so nothing downstream can interpret it.
    const evil = "Order concerning <script>alert(1)</script> the budget";
    const r = buildSnippet(evil, ["script"]);
    expect(joined(r)).toContain("<script>alert(1)</script>");
    expect(r.segments.every((s) => typeof s.text === "string")).toBe(true);
  });

  it("handles an empty document without throwing", () => {
    expect(() => buildSnippet("", ["x"])).not.toThrow();
    expect(() => buildSnippet(null, ["x"])).not.toThrow();
  });

  it("ignores empty needles", () => {
    expect(hits(buildSnippet(doc, ["", null, undefined]))).toEqual([]);
  });

  it("collapses whitespace so excerpts read as prose", () => {
    const r = buildSnippet("a\n\n\n   b", ["a"]);
    expect(joined(r)).toBe("a b");
  });
});
