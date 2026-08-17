import { describe, expect, it } from "vitest";

import { DEFAULT_STATE, readHash, writeHash } from "../src/state/hash.js";

const STATES = [
  { ...DEFAULT_STATE },
  { ...DEFAULT_STATE, q: "tenant housing" },
  { ...DEFAULT_STATE, view: "analytics" },
  { ...DEFAULT_STATE, eo: "1975-EO-040" },
  // Sorted, because list order is deliberately normalized on the way through
  // (see the dedicated test below).
  { ...DEFAULT_STATE, mayor: ["Beame", "Koch"] },
  { ...DEFAULT_STATE, yearMin: 1974, yearMax: 1989 },
  { ...DEFAULT_STATE, isEmergency: false },
  { ...DEFAULT_STATE, isEmergency: true },
  { ...DEFAULT_STATE, q: 'a "b c" & d=e#f', mode: "regex", text_quality: ["needs-review"] },
  // The gallery tab. "none" is a real selectable value -- crops the upstream
  // heuristic declined to tag -- and must survive the trip as a list member.
  { ...DEFAULT_STATE, view: "pictures", q: "robert moses", picture_tag: ["seal", "sig"] },
  { ...DEFAULT_STATE, view: "pictures", picture_tag: ["none"] },
];

describe("hash round-trip", () => {
  it("read(write(state)) equals the original for every representative state", () => {
    for (const state of STATES) {
      expect(readHash(writeHash(state))).toEqual(state);
    }
  });

  it("normalizes list order on the way through", () => {
    // Selection order is not meaningful state. Normalizing it is what makes
    // writeHash stable, so it is asserted rather than left implicit.
    expect(readHash(writeHash({ ...DEFAULT_STATE, mayor: ["Koch", "Beame"] })).mayor).toEqual([
      "Beame",
      "Koch",
    ]);
  });

  it("serializes the same logical state to the same string", () => {
    // If list order leaked through, writeHash would produce a different string
    // on every render and history.replaceState would churn.
    const a = writeHash({ ...DEFAULT_STATE, mayor: ["Koch", "Beame"] });
    const b = writeHash({ ...DEFAULT_STATE, mayor: ["Beame", "Koch"] });
    expect(a).toBe(b);
  });

  it("omits defaults so a pristine state has an empty hash", () => {
    expect(writeHash({ ...DEFAULT_STATE })).toBe("");
  });

  it("ignores unknown keys rather than crashing on them", () => {
    const s = readHash("#q=x&somethingElse=1&mayor=Koch");
    expect(s.q).toBe("x");
    expect(s.mayor).toEqual(["Koch"]);
    expect(s.somethingElse).toBeUndefined();
  });

  it("falls back to defaults on a malformed hash", () => {
    expect(readHash("#").view).toBe("browse");
    expect(readHash("").mayor).toEqual([]);
    expect(readHash("#%%%%").view).toBe("browse");
  });

  it("survives values containing &, = and spaces", () => {
    const state = { ...DEFAULT_STATE, q: "a&b=c d" };
    expect(readHash(writeHash(state)).q).toBe("a&b=c d");
  });

  it("parses a non-numeric year bound as null", () => {
    expect(readHash("#yearMin=abc").yearMin).toBe(null);
  });

  it("distinguishes isEmergency=false from absent", () => {
    expect(readHash("#isEmergency=false").isEmergency).toBe(false);
    expect(readHash("#").isEmergency).toBe(null);
  });
});
