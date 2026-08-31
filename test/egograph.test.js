import { describe, expect, it } from "vitest";

import { initials, layout, shortLabel } from "../src/components/EgoGraph.jsx";

const neighbour = (id, shared) => ({
  entity_id: id,
  display_name: id,
  kind: "registry",
  shared,
  affinity: 0.5,
});

describe("layout", () => {
  it("puts nothing anywhere when there is nothing to draw", () => {
    expect(layout([])).toEqual({ nodes: [], chords: [], maxWeight: 0 });
  });

  it("does not divide by zero on a ring of one", () => {
    const { nodes } = layout([neighbour("a", 3)]);
    expect(nodes).toHaveLength(1);
    expect(Number.isFinite(nodes[0].x)).toBe(true);
    expect(Number.isFinite(nodes[0].y)).toBe(true);
  });

  it("never lands two nodes on the same point", () => {
    // The alternating left/right placement is the part that could silently
    // collide, and a collision reads as a missing agency rather than as a bug.
    for (const n of [2, 3, 5, 12, 24, 25]) {
      const nodes = layout(
        Array.from({ length: n }, (_, i) => neighbour(`a${i}`, n - i))
      ).nodes;
      const seen = new Set(nodes.map((d) => `${d.x.toFixed(4)},${d.y.toFixed(4)}`));
      expect(seen.size, `ring of ${n}`).toBe(n);
    }
  });

  it("places the strongest neighbour at the top", () => {
    const { nodes } = layout([neighbour("first", 40), neighbour("second", 20)]);
    // -PI/2 is straight up in SVG coordinates, where y grows downward.
    expect(nodes[0].angle).toBeCloseTo(-Math.PI / 2);
    expect(nodes[0].y).toBeLessThan(nodes[1].y);
  });

  it("alternates sides so labels do not stack", () => {
    const { nodes } = layout(Array.from({ length: 6 }, (_, i) => neighbour(`a${i}`, 6 - i)));
    // Rank 0 is straight up and centred; after that they alternate.
    expect(nodes[1].x).toBeLessThan(nodes[0].x);
    expect(nodes[2].x).toBeGreaterThan(nodes[0].x);
    expect(nodes[3].x).toBeLessThan(nodes[0].x);
  });

  it("sizes by weight, not by rank", () => {
    const { nodes } = layout([neighbour("big", 100), neighbour("small", 1)]);
    expect(nodes[0].r).toBeGreaterThan(nodes[1].r);
  });

  it("gives every node the same size when every weight is the same", () => {
    const { nodes } = layout([neighbour("a", 5), neighbour("b", 5), neighbour("c", 5)]);
    expect(new Set(nodes.map((d) => d.r.toFixed(6))).size).toBe(1);
  });

  it("drops a chord that names an agency not on the ring", () => {
    // The edge query is bounded by the node list, but a stale render could pair
    // them up, and drawing a line to nowhere is worse than drawing nothing.
    const { chords } = layout(
      [neighbour("a", 3), neighbour("b", 3)],
      [
        { src: "a", dst: "b", shared: 3 },
        { src: "a", dst: "ghost", shared: 9 },
      ]
    );
    expect(chords).toHaveLength(1);
    expect(chords[0].key).toBe("a~b");
  });

  it("draws only the strongest chords, so the ring does not fill in solid", () => {
    // 24 nodes allow 276 pairs. Drawing them all hides the spokes.
    const nodes = Array.from({ length: 24 }, (_, i) => neighbour(`a${i}`, 24 - i));
    const every = [];
    for (let i = 0; i < 24; i += 1)
      for (let j = i + 1; j < 24; j += 1)
        every.push({ src: `a${i}`, dst: `a${j}`, shared: i + j });
    const { chords } = layout(nodes, every);
    expect(every.length).toBeGreaterThan(200);
    expect(chords.length).toBe(28);
    // And it kept the strongest, not the first 28 it happened to see.
    expect(Math.min(...chords.map((c) => c.weight))).toBeGreaterThan(
      Math.min(...every.map((e) => e.shared))
    );
  });

  it("keeps every chord visible but never opaque", () => {
    const { chords } = layout(
      [neighbour("a", 3), neighbour("b", 3), neighbour("c", 3)],
      [
        { src: "a", dst: "b", shared: 40 },
        { src: "b", dst: "c", shared: 1 },
      ]
    );
    for (const c of chords) {
      expect(c.opacity).toBeGreaterThan(0);
      expect(c.opacity).toBeLessThanOrEqual(0.61);
    }
  });

  it("anchors a label on the side its node sits on", () => {
    const { nodes } = layout(Array.from({ length: 8 }, (_, i) => neighbour(`a${i}`, 8 - i)));
    for (const d of nodes) {
      if (d.anchor === "start") expect(d.x).toBeGreaterThan(560);
      if (d.anchor === "end") expect(d.x).toBeLessThan(560);
    }
  });
});

describe("shortLabel", () => {
  it("leaves a name that fits alone", () => {
    expect(shortLabel("Department of Buildings")).toBe("Department of Buildings");
  });

  it("trims a long one and says it trimmed", () => {
    const out = shortLabel("Department of Information Technology and Telecommunications");
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(34);
  });
});

describe("initials", () => {
  it("skips the joining words", () => {
    expect(initials("Department of Correction")).toBe("DC");
    expect(initials("Board of Estimate")).toBe("BE");
    expect(initials("Office of Citywide Event Coordination")).toBe("OCE");
  });
});
