import { describe, expect, it } from "vitest";

import {
  EVENT_LABEL,
  KIND_PROPOSED,
  KIND_REGISTRY,
  chainOf,
  classificationLabel,
  counterpart,
  kindClass,
  otherNames,
  markSegments,
  toArray,
} from "../src/data/entities.js";
import {
  assertNoPrefixCollision,
  collapseSpaces,
  entityRows,
  eventRows,
  mentionRows,
  normalizeName,
  pickDisplayName,
  proposedEntityId,
  unplacedRoles,
} from "../scripts/lib/entities.mjs";

describe("normalizeName", () => {
  it("matches what lineage/normalize.py does", () => {
    // These four cases are the whole contract: one case, no leading article, no
    // punctuation, single spaces. If they drift from the Python, the same
    // agency gets two different ids and the join stops meaning anything.
    expect(normalizeName("The Board of Estimate")).toBe("board of estimate");
    expect(normalizeName("Mayor's Office")).toBe("mayor s office");
    expect(normalizeName("DEPARTMENT  OF\nWELFARE")).toBe("department of welfare");
    expect(normalizeName("Office of the Mayor")).toBe("office of the mayor");
  });

  it("drops accents rather than keeping two spellings apart", () => {
    expect(normalizeName("Bureau of Régistration")).toBe("bureau of registration");
  });
});

describe("proposedEntityId", () => {
  it("prefixes, so a minted id can never look like a registry slug", () => {
    expect(proposedEntityId("Board of Estimate")).toBe("x-board-of-estimate");
  });

  it("gives one id to the spellings that are one body", () => {
    // Upstream groups proposed names by their exact string, so these arrive as
    // two names seen 30 and 22 times. They are the same programme.
    expect(proposedEntityId("Legislative Program")).toBe(
      proposedEntityId("LEGISLATIVE PROGRAM")
    );
  });

  it("returns null rather than a bare prefix", () => {
    expect(proposedEntityId("   ")).toBeNull();
    expect(proposedEntityId(null)).toBeNull();
  });
});

describe("assertNoPrefixCollision", () => {
  it("passes on real-shaped registry ids", () => {
    expect(() =>
      assertNoPrefixCollision([{ id: "oti" }, { id: "office-of-the-mayor" }])
    ).not.toThrow();
  });

  it("fails loudly when a registry id would shadow a minted one", () => {
    expect(() => assertNoPrefixCollision([{ id: "x-ray-commission" }])).toThrow(
      /must not start with/
    );
  });
});

describe("mentionRows", () => {
  const payload = {
    mentions: [
      {
        eo_id: "1946-EO-002",
        start: 19,
        end: 38,
        text: "OFFICE OF THE MAYOR",
        agency_id: "office-of-the-mayor",
        pins_down: "one-agency",
      },
      {
        eo_id: "1946-EO-003",
        start: 200,
        end: 214,
        text: "Mayor's Office",
        agency_id: null,
        pins_down: "several-agencies",
        agency_ids: ["nyc-mayor", "office-of-the-mayor"],
      },
    ],
    proposed: [
      {
        eo_id: "1946-EO-003",
        start: 2244,
        end: 2265,
        text: "Department of Welfare",
        name: "Department of Welfare",
      },
    ],
  };

  it("emits a row for every candidate of an ambiguous name, all flagged", () => {
    // The scan refused to pick one agency. Picking one here would invent the
    // fact it declined to invent, so the name shows on both pages, marked.
    const rows = mentionRows(payload).filter((r) => r.eo_id === "1946-EO-003" && r.ambiguous);
    expect(rows.map((r) => r.entity_id).sort()).toEqual(["nyc-mayor", "office-of-the-mayor"]);
    expect(rows.every((r) => r.kind === KIND_REGISTRY)).toBe(true);
  });

  it("does not flag a name that pinned down one agency", () => {
    const [row] = mentionRows(payload).filter((r) => r.eo_id === "1946-EO-002");
    expect(row.ambiguous).toBe(false);
    expect(row.entity_id).toBe("office-of-the-mayor");
  });

  it("carries proposed names into the same key space, marked as such", () => {
    const row = mentionRows(payload).find((r) => r.kind === KIND_PROPOSED);
    expect(row.entity_id).toBe("x-department-of-welfare");
    expect(row.text).toBe("Department of Welfare");
  });

  it("keeps the offsets untouched, because the raw view slices on them", () => {
    const row = mentionRows(payload).find((r) => r.entity_id === "office-of-the-mayor");
    expect([row.start, row.end]).toEqual([19, 38]);
  });

  it("carries the letterhead mark through instead of dropping the row", () => {
    // Upstream marks the mayoral stationery rather than deleting it. This table
    // stays the complete record; the queries that count decide what to leave out.
    const marked = mentionRows({
      mentions: [
        {
          eo_id: "1946-EO-002",
          start: 19,
          end: 38,
          text: "OFFICE OF THE MAYOR",
          agency_id: "office-of-the-mayor",
          pins_down: "one-agency",
          in_letterhead: true,
        },
      ],
    });
    expect(marked).toHaveLength(1);
    expect(marked[0].in_letterhead).toBe(true);
  });

  it("gives every row the mark, false where upstream said nothing", () => {
    // A missing key must become `false`, not `undefined` -- the column is
    // declared BOOLEAN and DuckDB reads what this writes.
    const rows = mentionRows(payload);
    expect(rows.every((r) => typeof r.in_letterhead === "boolean")).toBe(true);
    expect(rows.some((r) => r.in_letterhead)).toBe(false);
  });
});

describe("pickDisplayName", () => {
  it("titles a page with the spelling used most, alphabetical on a tie", () => {
    expect(
      pickDisplayName(
        new Map([
          ["LEGISLATIVE PROGRAM", 22],
          ["Legislative Program", 30],
        ])
      )
    ).toEqual({ display_name: "Legislative Program", other_names: ["LEGISLATIVE PROGRAM"] });

    expect(
      pickDisplayName(
        new Map([
          ["Bureau B", 4],
          ["Bureau A", 4],
        ])
      ).display_name
    ).toBe("Bureau A");
  });
});

describe("entityRows", () => {
  const payload = {
    agencies: [
      {
        id: "doc",
        name: "Department of Correction",
        short_name: "DOC",
        other_names: ["DOC"],
        government_level: "nyc",
        classification: "Mayoral Agency",
        primary_domain: "www.nyc.gov",
        status: "active",
        description: "About the department.",
        description_source_url: "https://example.invalid/about",
      },
    ],
    mentions: [
      { eo_id: "A", start: 0, end: 3, text: "DOC", agency_id: "doc", pins_down: "one-agency" },
      { eo_id: "A", start: 9, end: 12, text: "DOC", agency_id: "doc", pins_down: "one-agency" },
      {
        eo_id: "B",
        start: 0,
        end: 24,
        text: "Department of\nCorrection",
        agency_id: "doc",
        pins_down: "one-agency",
      },
    ],
    proposed: [
      { eo_id: "B", start: 40, end: 57, text: "Board of Estimate", name: "Board of Estimate" },
    ],
  };
  const years = new Map([
    ["A", 1975],
    ["B", 1990],
  ]);

  const rows = entityRows(payload, mentionRows(payload), years);
  const doc = rows.find((r) => r.entity_id === "doc");
  const boe = rows.find((r) => r.entity_id === "x-board-of-estimate");

  it("counts orders, not mentions", () => {
    // DOC is named three times but in two orders. Weighting it as three would
    // make a co-mention score a measure of how often a drafter repeated a name.
    expect(doc.eo_count).toBe(2);
    expect(doc.mention_count).toBe(3);
  });

  it("titles a confirmed agency by the registry name, not by the loudest spelling", () => {
    // "DOC" is written twice and the full name once; the page still belongs
    // under the department's actual name.
    expect(doc.display_name).toBe("Department of Correction");
    expect(doc.short_name).toBe("DOC");
  });

  it("carries the registry facts through, and leaves them null for a proposed name", () => {
    expect(doc.primary_domain).toBe("www.nyc.gov");
    expect(doc.description).toBe("About the department.");
    expect(boe.kind).toBe(KIND_PROPOSED);
    expect(boe.primary_domain).toBeNull();
    expect(boe.description).toBeNull();
    expect(boe.classification).toBeNull();
  });

  it("records the years the corpus actually names it", () => {
    expect([doc.first_year, doc.last_year]).toEqual([1975, 1990]);
    expect([boe.first_year, boe.last_year]).toEqual([1990, 1990]);
  });

  it("is sorted by id, so a rebuild cannot reorder the file", () => {
    expect(rows.map((r) => r.entity_id)).toEqual([...rows.map((r) => r.entity_id)].sort());
  });
});

describe("entityRows and the letterhead", () => {
  // Two orders name the office on their stationery and one names it in a
  // sentence -- the real shape, where the letterhead is most of the finds.
  const mention = (eo_id, start, text, extra = {}) => ({
    eo_id,
    start,
    end: start + text.length,
    text,
    agency_id: "office-of-the-mayor",
    pins_down: "one-agency",
    ...extra,
  });
  const payload = {
    agencies: [{ id: "office-of-the-mayor", name: "Office of the Mayor", other_names: [] }],
    mentions: [
      mention("A", 19, "OFFICE OF THE MAYOR", { in_letterhead: true }),
      mention("B", 21, "OFFICE OF THE MAYOR", { in_letterhead: true }),
      mention("B", 900, "Office of the Mayor"),
    ],
  };
  const years = new Map([
    ["A", 1946],
    ["B", 2014],
  ]);
  const [row] = entityRows(payload, mentionRows(payload), years);

  it("counts the body and sets the letterhead aside", () => {
    // Counting the stationery would say the office is named in every order in
    // the corpus, which is true of its notepaper and not of the orders.
    expect(row.mention_count).toBe(1);
    expect(row.letterhead_count).toBe(2);
    expect(row.eo_count).toBe(1);
  });

  it("takes its years from the body too", () => {
    // Order A names it on the letterhead only, so 1946 is not a year in which
    // an order actually had anything to say about the office.
    expect([row.first_year, row.last_year]).toEqual([2014, 2014]);
  });

  it("refuses to build an entity that is letterhead and nothing else", () => {
    // Cannot happen today -- upstream marks only the mayoral masthead, and that
    // has 250 body finds. A widened rule upstream would otherwise leave a page
    // with no title at all, which shows up as a blank in production.
    const only = {
      agencies: [],
      mentions: [mention("A", 19, "OFFICE OF THE MAYOR", { in_letterhead: true })],
    };
    expect(() => entityRows(only, mentionRows(only), years)).toThrow(/all of them are/);
  });
});

describe("collapseSpaces", () => {
  it("makes a line-wrapped name usable as a label", () => {
    // Pulling text out of a PDF wraps names across lines constantly. The raw
    // text stays exact; only the label is tidied.
    expect(collapseSpaces("Cyber\nCommand")).toBe("Cyber Command");
    expect(collapseSpaces("Department  of\n  Buildings")).toBe("Department of Buildings");
  });
});

describe("markSegments", () => {
  const text = "The Department of Correction and the Board of Estimate agree.";

  it("slices at the recorded offsets rather than searching again", () => {
    const segs = markSegments(text, [{ start: 4, end: 28, entity_id: "doc" }]);
    expect(segs.filter((s) => s.marked).map((s) => s.text)).toEqual([
      "Department of Correction",
    ]);
    expect(segs.map((s) => s.text).join("")).toBe(text);
  });

  it("merges overlapping spans instead of nesting one mark inside another", () => {
    const segs = markSegments(text, [
      { start: 4, end: 28, entity_id: "doc" },
      { start: 4, end: 14, entity_id: "x-department" },
    ]);
    const marked = segs.filter((s) => s.marked);
    expect(marked).toHaveLength(1);
    expect(marked[0].ids.sort()).toEqual(["doc", "x-department"]);
  });

  it("puts the text back together exactly, every time", () => {
    const segs = markSegments(text, [
      { start: 37, end: 54, entity_id: "x-board-of-estimate" },
      { start: 4, end: 28, entity_id: "doc" },
    ]);
    expect(segs.map((s) => s.text).join("")).toBe(text);
  });

  it("survives an offset past the end of the text", () => {
    // Would mean the mentions were generated against a different corpus. It
    // must degrade, not throw.
    const segs = markSegments("short", [{ start: 2, end: 900, entity_id: "x" }]);
    expect(segs.map((s) => s.text).join("")).toBe("short");
  });

  it("returns the whole text unmarked when there is nothing to mark", () => {
    expect(markSegments(text, [])).toEqual([{ text, marked: false, ids: [] }]);
  });
});

describe("toArray", () => {
  it("normalizes the three shapes a LIST column arrives in", () => {
    expect(toArray(null)).toEqual([]);
    expect(toArray(["a", "b"])).toEqual(["a", "b"]);
    expect(toArray({ items: ["a"] })).toEqual(["a"]);
  });
});

describe("kindClass", () => {
  it("names the badge by kind", () => {
    expect(kindClass(KIND_REGISTRY)).toBe("badge kind-registry");
    expect(kindClass(KIND_PROPOSED)).toBe("badge kind-proposed");
  });
});

describe("classificationLabel", () => {
  it("leaves the phrase form exactly as the registry wrote it", () => {
    expect(classificationLabel("Mayoral Agency")).toBe("Mayoral Agency");
    expect(classificationLabel("Advisory or Regulatory Organization")).toBe(
      "Advisory or Regulatory Organization"
    );
  });

  it("makes the slug form readable, so the two spellings match on screen", () => {
    // Both really are in the registry: the bulk import writes one, the
    // hand-authored seed records the other.
    expect(classificationLabel("mayoral-agency")).toBe("Mayoral Agency");
    expect(classificationLabel("public-benefit-corporation")).toBe(
      "Public Benefit Corporation"
    );
    expect(classificationLabel("mta-subsidiary")).toBe("Mta Subsidiary");
  });

  it("survives a missing value", () => {
    expect(classificationLabel(null)).toBe("");
    expect(classificationLabel(undefined)).toBe("");
  });
});

describe("otherNames", () => {
  it("drops the acronym the page already shows on its own line", () => {
    // The registry repeats short_name as the first entry of other_names for
    // nearly every agency that has one. Printed twice it reads as a mistake.
    expect(
      otherNames({
        display_name: "New York City Law Department",
        name: "New York City Law Department",
        short_name: "LAW",
        other_names: [
          "LAW",
          "Law Department",
          "Office of the Corporation Counsel",
          "Law Dept.",
        ],
      })
    ).toEqual(["Law Department", "Office of the Corporation Counsel", "Law Dept."]);
  });

  it("keeps the former names, which are the half worth reading", () => {
    // "Office of Emergency Management" is how a 2005 order names the agency
    // that is now NYCEM. Losing it would break the link across the rename.
    expect(
      otherNames({
        display_name: "New York City Emergency Management",
        short_name: "NYCEM",
        other_names: [
          "NYCEM",
          "NYC Emergency Management",
          "Office of Emergency Management",
          "OEM",
        ],
      })
    ).toEqual(["NYC Emergency Management", "Office of Emergency Management", "OEM"]);
  });

  it("drops a repeat of the title even when it is punctuated differently", () => {
    expect(
      otherNames({
        display_name: "Mayor's Office",
        other_names: ["Mayors Office", "MAYOR'S OFFICE", "Executive Office"],
      })
    ).toEqual(["Executive Office"]);
  });

  it("handles an agency the registry gave no alternate names at all", () => {
    expect(otherNames({ display_name: "Sheriff", other_names: [] })).toEqual([]);
    expect(otherNames({ display_name: "Sheriff" })).toEqual([]);
    expect(otherNames(null)).toEqual([]);
  });

  it("reads the Arrow shape a LIST column arrives in", () => {
    expect(otherNames({ display_name: "A", other_names: { items: ["A", "B"] } })).toEqual([
      "B",
    ]);
  });
});

describe("eventRows", () => {
  // One of each shape the corpus actually holds: an establishment inside a
  // parent, a rename between two bodies, an abolition with only one side, and a
  // role naming something that has no page here.
  const payload = {
    agency_events: [
      {
        eo_id: "B",
        kind: "establishes",
        verb: "established",
        start: 10,
        end: 60,
        text: "there is hereby established, in the Office of the Mayor, an Office of X",
        roles: [
          {
            role: "to",
            agency_id: null,
            name: "Office of X",
            start: 40,
            end: 51,
            text: "Office\nof X",
            found_by: "new-name",
          },
          {
            role: "parent",
            agency_id: "office-of-the-mayor",
            name: "Office of the Mayor",
            start: 20,
            end: 39,
            text: "Office of the Mayor",
            found_by: "known-name",
          },
        ],
      },
      {
        eo_id: "A",
        kind: "renames",
        verb: "designated",
        start: 5,
        end: 40,
        text: "the Office of X shall hereafter be designated the Bureau of Y",
        roles: [
          {
            role: "from",
            agency_id: null,
            name: "Office of X",
            start: 9,
            end: 20,
            text: "Office of X",
            found_by: "new-name",
          },
          {
            role: "to",
            agency_id: null,
            name: "Nowhere Committee",
            start: 25,
            end: 42,
            text: "Nowhere Committee",
            found_by: "new-name",
          },
        ],
      },
      {
        eo_id: "A",
        kind: "abolishes",
        verb: "abolished",
        start: 80,
        end: 110,
        text: "the Board of Estimate is hereby abolished",
        roles: [
          {
            role: "from",
            agency_id: null,
            name: "Board of Estimate",
            start: 84,
            end: 101,
            text: "Board of Estimate",
            found_by: "new-name",
          },
        ],
      },
      {
        eo_id: "GONE",
        kind: "establishes",
        verb: "created",
        start: 0,
        end: 10,
        text: "created",
        roles: [{ role: "to", agency_id: "office-of-the-mayor", name: "Office of the Mayor" }],
      },
    ],
  };
  const ids = new Set(["office-of-the-mayor", "x-office-of-x", "x-board-of-estimate"]);
  const rows = eventRows(payload, ids, new Set(["A", "B"]));

  it("gives one row per event, not one per role", () => {
    // Upstream never fills the same role twice, which is the whole reason an
    // event can be flat. A row per role would make "every event naming this
    // agency" a self-join for no gain.
    expect(rows).toHaveLength(3);
  });

  it("resolves a role with no agency_id through the proposed id scheme", () => {
    // The registry lists agencies active today, so a body that was renamed away
    // arrives with agency_id null and nothing else. Minting the same id the
    // mention pass mints is what puts it on its own page.
    const rename = rows.find((r) => r.kind === "renames");
    expect(rename.from_id).toBe("x-office-of-x");
  });

  it("leaves the id null but keeps the name when the body has no page", () => {
    const rename = rows.find((r) => r.kind === "renames");
    expect(rename.to_id).toBeNull();
    expect(rename.to_name).toBe("Nowhere Committee");
  });

  it("never lets a parent role become a side of the event", () => {
    // The Office of the Mayor is the parent of dozens of bodies. Counting those
    // as its own lineage would say it was created dozens of times.
    const est = rows.find((r) => r.kind === "establishes");
    expect(est.from_id).toBeNull();
    expect(est.to_id).toBe("x-office-of-x");
    expect(est.parent_name).toBe("Office of the Mayor");
    expect(rows.some((r) => r.from_id === "office-of-the-mayor")).toBe(false);
    expect(rows.some((r) => r.to_id === "office-of-the-mayor")).toBe(false);
  });

  it("collapses a name that wrapped across a line", () => {
    // "Office\nof X" is the ordinary case in text pulled out of a PDF.
    const est = rows.find((r) => r.kind === "establishes");
    expect(est.to_name).toBe("Office of X");
  });

  it("drops an event on an order the corpus does not hold", () => {
    expect(rows.some((r) => r.eo_id === "GONE")).toBe(false);
  });

  it("numbers events within their own order", () => {
    // Three events share an (eo_id, start, end) in the real corpus, so the span
    // is not a key and the row needs a sequence of its own. It counts per order,
    // so dropping one order can never renumber another one's events.
    expect(rows.filter((r) => r.eo_id === "A").map((r) => r.event_seq)).toEqual([0, 1]);
    expect(rows.find((r) => r.eo_id === "B").event_seq).toBe(0);
  });

  it("returns nothing when the payload has no events", () => {
    expect(eventRows({}, ids)).toEqual([]);
  });
});

describe("unplacedRoles", () => {
  it("names the bodies that have no page, so the build can report them", () => {
    const events = [
      {
        from_name: "Mayor's office",
        from_id: null,
        to_name: "Office of X",
        to_id: "x-office-of-x",
      },
      { from_name: null, from_id: null, to_name: "DOE", to_id: null },
    ];
    expect(unplacedRoles(events)).toEqual(["Mayor's office", "DOE"]);
  });
});

describe("entityRows and the event count", () => {
  const payload = {
    agencies: [],
    mentions: [],
    proposed: [
      { eo_id: "A", start: 0, end: 11, text: "Office of X", name: "Office of X" },
      { eo_id: "A", start: 20, end: 31, text: "Bureau of Y", name: "Bureau of Y" },
    ],
  };
  const years = new Map([["A", 1975]]);
  const rows = mentionRows(payload);

  it("is zero when no events are passed, which is an older data repo", () => {
    const out = entityRows(payload, rows, years);
    expect(out.every((r) => r.event_count === 0)).toBe(true);
  });

  it("counts an event on either side", () => {
    const events = [
      { from_id: "x-office-of-x", to_id: "x-bureau-of-y" },
      { from_id: null, to_id: "x-bureau-of-y" },
    ];
    const out = entityRows(payload, rows, years, events);
    expect(out.find((r) => r.entity_id === "x-office-of-x").event_count).toBe(1);
    expect(out.find((r) => r.entity_id === "x-bureau-of-y").event_count).toBe(2);
  });

  it("counts an event naming one agency on both sides once", () => {
    // The registry gives DoITT and OTI one slug, so the 2022 rename is
    // `oti -> oti`. That is one event in its history, not two.
    const events = [{ from_id: "x-office-of-x", to_id: "x-office-of-x" }];
    const out = entityRows(payload, rows, years, events);
    expect(out.find((r) => r.entity_id === "x-office-of-x").event_count).toBe(1);
  });
});

describe("chainOf", () => {
  const ev = (kind, from_id, to_id) => ({ kind, from_id, to_id, eo_id: "A", event_seq: 0 });

  it("puts a body this one was renamed FROM on the left", () => {
    const c = chainOf([ev("renames", "x-old", "me")], "me");
    expect(c.before).toHaveLength(1);
    expect(c.after).toHaveLength(0);
  });

  it("puts a body this one was renamed TO on the right", () => {
    const c = chainOf([ev("renames", "me", "x-new")], "me");
    expect(c.after).toHaveLength(1);
    expect(c.before).toHaveLength(0);
  });

  it("keeps a rename with one agency on both sides off the arrows", () => {
    // Drawn as an arrow it would leave the box and come straight back, which
    // reads as a bug rather than as a rename.
    const c = chainOf([ev("renames", "me", "me")], "me");
    expect(c.self).toHaveLength(1);
    expect(c.before).toHaveLength(0);
    expect(c.after).toHaveLength(0);
  });

  it("reads establish and continue as the start, and abolish as the end", () => {
    const c = chainOf(
      [ev("establishes", null, "me"), ev("continues", null, "me"), ev("abolishes", "me", null)],
      "me"
    );
    expect(c.start).toHaveLength(2);
    expect(c.end).toHaveLength(1);
  });

  it("returns every list empty rather than null when there is nothing", () => {
    expect(chainOf([], "me")).toEqual({
      before: [],
      after: [],
      self: [],
      start: [],
      end: [],
    });
  });
});

describe("counterpart", () => {
  it("names the other side, seen from this agency", () => {
    const e = {
      from_id: "me",
      from_name: "Office of X",
      to_id: "x-new",
      to_name: "Bureau of Y",
      to_display_name: "Bureau of Y",
      to_entity_kind: KIND_PROPOSED,
    };
    expect(counterpart(e, "me")).toEqual({
      entity_id: "x-new",
      name: "Bureau of Y",
      kind: KIND_PROPOSED,
    });
  });

  it("prefers the entity's own title over the spelling the order used", () => {
    // The order writes "DOC" and the page is titled "Department of Correction".
    const e = {
      from_id: "doc",
      from_name: "DOC",
      from_display_name: "Department of Correction",
      from_entity_kind: KIND_REGISTRY,
      to_id: "me",
      to_name: "Office of X",
    };
    expect(counterpart(e, "me").name).toBe("Department of Correction");
  });

  it("returns a name with no id rather than a dead link", () => {
    const e = {
      from_id: null,
      from_name: "Mayor's office",
      to_id: "me",
      to_name: "Office of X",
    };
    expect(counterpart(e, "me")).toEqual({
      entity_id: null,
      name: "Mayor's office",
      kind: null,
    });
  });

  it("returns null when the event has only one side", () => {
    // An abolition names the body and nothing else. There is no counterpart to
    // print, and printing the agency's own name back at it would be a lie.
    const e = { from_id: "me", from_name: "Office of X", to_id: null, to_name: null };
    expect(counterpart(e, "me")).toBeNull();
  });
});

describe("EVENT_LABEL", () => {
  it("reads as English from the point of view of the agency acted on", () => {
    // The page is ABOUT the body the sentence acts on, so the passive is right.
    expect(EVENT_LABEL.establishes).toBe("established");
    expect(EVENT_LABEL.transfers_to).toBe("transferred to");
  });
});
