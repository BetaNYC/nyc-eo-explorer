import { describe, expect, it } from "vitest";

import { longLabel, parseId, shortLabel } from "../src/data/labels.js";

describe("parseId", () => {
  it("splits the three-part identifier", () => {
    expect(parseId("2022-EEO-301")).toEqual({ year: "2022", series: "EEO", rest: "301" });
  });

  it("keeps a hyphenated tail intact", () => {
    expect(parseId("1967-EM-D0104-b").rest).toBe("D0104-b");
  });

  it("degrades on a malformed id instead of throwing", () => {
    expect(parseId("garbage").series).toBe(null);
    expect(parseId(null).rest).toBe("");
    expect(parseId(undefined).rest).toBe("");
  });
});

describe("shortLabel", () => {
  it("uses the printed number when there is one", () => {
    expect(shortLabel({ eo_id: "2024-EO-040", number: "040" })).toBe("EO 040");
  });

  it("falls back to the identifier tail when number is NULL", () => {
    // Pre-1974 records with no printed number get a date-derived identifier.
    expect(shortLabel({ eo_id: "1973-AM-D0628", number: null })).toBe("AM D0628");
  });

  it("does not present the UNK sentinel as if it were a number", () => {
    // "UNK"/"UNKf" is upstream's marker for a number that could not be read
    // off the scan. 100 records carry it; rendering it verbatim reads like a
    // real order number.
    expect(shortLabel({ eo_id: "1973-EO-UNKf", number: null })).toBe("EO (unnumbered)");
    expect(shortLabel({ eo_id: "1973-EO-UNK", number: null })).toBe("EO (unnumbered)");
  });

  it("carries a series it has never seen", () => {
    // The remaining bound volumes may introduce more series; nothing may
    // hardcode EO|EEO.
    expect(shortLabel({ eo_id: "1951-XX-007", number: "7" })).toBe("XX 7");
  });

  it("preserves suffixed numbers rather than coercing them", () => {
    expect(shortLabel({ eo_id: "1980-EO-27A", number: "27A" })).toBe("EO 27A");
  });
});

describe("longLabel", () => {
  it("expands the two known series", () => {
    expect(longLabel({ eo_id: "2024-EO-040", number: "040" })).toBe("Executive Order No. 040");
    expect(longLabel({ eo_id: "2022-EEO-301", number: "301" })).toBe(
      "Emergency Executive Order No. 301"
    );
  });

  it("does not invent an expansion for an unknown series", () => {
    expect(longLabel({ eo_id: "1973-AM-D0628", number: null })).toBe("AM D0628");
  });

  it("says the number is missing rather than printing the sentinel", () => {
    expect(longLabel({ eo_id: "1973-EO-UNKf", number: null })).toBe(
      "Executive Order (number not recorded)"
    );
  });

  it("never renders a bare null", () => {
    for (const row of [
      { eo_id: "1973-AM-D0628", number: null },
      { eo_id: "1973-EO-UNKf", number: null },
      { eo_id: "garbage", number: null },
      { eo_id: null, number: null },
    ]) {
      expect(longLabel(row)).not.toContain("null");
      expect(shortLabel(row)).not.toContain("null");
      expect(longLabel(row)).not.toMatch(/UNK/);
      expect(shortLabel(row)).not.toMatch(/UNK/);
    }
  });
});
