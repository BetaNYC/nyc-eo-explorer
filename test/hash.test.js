import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_STATE, canGoBack, pushHash, readHash, writeHash } from "../src/state/hash.js";

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

describe("graph selection in the hash", () => {
  it("round-trips the agencies chosen on the graph", () => {
    const state = readHash("#entity=x-board-of-estimate&also=nyc-council,nyc-comptroller");
    expect(state.entity).toBe("x-board-of-estimate");
    expect(state.also).toEqual(["nyc-comptroller", "nyc-council"]);
    // Sorted on the way in and on the way out, so the same set of agencies
    // always produces the same link no matter what order they were clicked.
    // (The separator rides through URLSearchParams percent-encoded, as every
    // other multi-value key in this app already does.)
    expect(readHash(writeHash(state)).also).toEqual(["nyc-comptroller", "nyc-council"]);
    expect(writeHash(state)).toBe(
      writeHash(readHash("#entity=x-board-of-estimate&also=nyc-comptroller,nyc-council"))
    );
  });

  it("leaves an empty selection out of the link entirely", () => {
    expect(writeHash({ ...DEFAULT_STATE, entity: "oti", also: [] })).toBe("#entity=oti");
  });

  it("survives a hand-edited link with a trailing comma", () => {
    expect(readHash("#entity=oti&also=doc,").also).toEqual(["doc"]);
  });
});

/**
 * The smallest window the history helpers need: an entry stack, plus back().
 *
 * The browser's own history is not available in a node test, and jsdom's cannot
 * go back over a pushState. The stack below is the part that matters -- an
 * entry holds a hash AND a state object, and back() restores both.
 */
function fakeWindow(hash = "") {
  const entries = [{ hash, state: null }];
  let at = 0;
  const win = {
    location: {
      pathname: "/",
      get hash() {
        return entries[at].hash;
      },
    },
    history: {
      get state() {
        return entries[at].state;
      },
      pushState(state, _title, url) {
        entries.length = at + 1;
        entries.push({ hash: String(url).startsWith("#") ? String(url) : "", state });
        at += 1;
      },
      replaceState(state, _title, url) {
        entries[at] = { hash: String(url).startsWith("#") ? String(url) : "", state };
      },
      back() {
        if (at > 0) at -= 1;
      },
    },
    entries,
  };
  return win;
}

describe("back over the history the app writes", () => {
  afterEach(() => {
    delete globalThis.window;
  });

  it("returns to the exact state a page was left in, filters and all", () => {
    globalThis.window = fakeWindow();

    // The agencies index, filtered.
    const index = { ...DEFAULT_STATE, view: "entities", entity_q: "board", entity_min: 5 };
    pushHash(index);
    expect(canGoBack()).toBe(false);

    // Into one agency, then two picks on its graph and a cap: replaced, so all
    // of it belongs to the same entry.
    const agency = { ...index, entity: "x-board-of-estimate" };
    pushHash(agency, "push");
    const filtered = { ...agency, also: ["nyc-comptroller"], max_agencies: 6 };
    pushHash(filtered);

    // Into an order from that graph.
    pushHash({ ...filtered, entity: null, eo: "1975-EO-040" }, "push");
    expect(canGoBack()).toBe(true);

    window.history.back();
    // The agency page as it was: the picks and the cap, not a bare agency page
    // and not the index.
    expect(readHash(window.location.hash)).toEqual(filtered);

    window.history.back();
    expect(readHash(window.location.hash)).toEqual(index);
    expect(canGoBack()).toBe(false);
  });

  it("adds no entry for a filter change", () => {
    globalThis.window = fakeWindow();
    pushHash({ ...DEFAULT_STATE, q: "tenant" });
    pushHash({ ...DEFAULT_STATE, q: "tenant housing" });
    pushHash({ ...DEFAULT_STATE, q: "tenant housing", mayor: ["Koch"] });
    expect(window.entries).toHaveLength(1);
    expect(canGoBack()).toBe(false);
  });

  it("adds no entry for a push to the state already showing", () => {
    globalThis.window = fakeWindow();
    const state = { ...DEFAULT_STATE, eo: "1975-EO-040" };
    pushHash(state, "push");
    pushHash(state, "push");
    expect(window.entries).toHaveLength(2);
  });

  it("reports no way back on a link opened straight to an order", () => {
    globalThis.window = fakeWindow("#eo=1975-EO-040");
    pushHash(readHash("#eo=1975-EO-040"));
    expect(canGoBack()).toBe(false);
  });
});
