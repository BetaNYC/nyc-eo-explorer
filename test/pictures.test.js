import { describe, expect, it } from "vitest";

import { PICTURE_TAGS, flattenPictures, tagKey, tagLabel } from "../src/data/pictures.js";

describe("flattenPictures", () => {
  it("turns the eo_id -> [crop] map into one row per crop", () => {
    const rows = flattenPictures({
      "1946-EO-002": [
        { image: "vol/page_0013_pic_00_seal.png", tag: "seal", page: 13 },
        { image: "vol/page_0015_pic_01_sig.png", tag: "sig", page: 15 },
      ],
      "1946-EO-003": [{ image: "vol/page_0017_pic_00_seal.png", tag: "seal", page: 17 }],
    });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      eo_id: "1946-EO-002",
      image: "vol/page_0013_pic_00_seal.png",
      tag: "seal",
      page: 13,
    });
  });

  it("keeps an untagged crop as null rather than dropping or renaming it", () => {
    // The upstream heuristic declining to guess is a third answer. A flattener
    // that coerced it to "" or "none" would make the SQL `tag IS NULL` branch
    // dead code and the "untagged" chip always read zero.
    const [row] = flattenPictures({ x: [{ image: "a.png", tag: null, page: 1 }] });
    expect(row.tag).toBe(null);
  });

  it("treats a missing tag key the same as an explicit null", () => {
    const [row] = flattenPictures({ x: [{ image: "a.png", page: 1 }] });
    expect(row.tag).toBe(null);
  });

  it("keeps a crop that two orders share, once per order", () => {
    // A volume page where one order ends and the next begins belongs to both,
    // and the builder already duplicates it. Deduplicating here would take the
    // crop away from one of them.
    const rows = flattenPictures({
      "1946-EO-002": [{ image: "vol/page_0015_pic_00.png", tag: null, page: 15 }],
      "1946-EO-003": [{ image: "vol/page_0015_pic_00.png", tag: null, page: 15 }],
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.eo_id)).toEqual(["1946-EO-002", "1946-EO-003"]);
  });

  it("returns an empty list for an absent or empty side-car", () => {
    expect(flattenPictures({})).toEqual([]);
    expect(flattenPictures(undefined)).toEqual([]);
    expect(flattenPictures({ x: null })).toEqual([]);
  });
});

describe("picture tags", () => {
  it("offers untagged as its own option, last", () => {
    expect(PICTURE_TAGS).toEqual(["seal", "sig", null]);
  });

  it("maps null to a key that can ride in a URL and a SQL parameter", () => {
    expect(PICTURE_TAGS.map(tagKey)).toEqual(["seal", "sig", "none"]);
  });

  it("labels every tag as a guess, including the absence of one", () => {
    expect(tagLabel("seal")).toBe("likely city seal");
    expect(tagLabel("sig")).toBe("likely signature");
    expect(tagLabel(null)).toBe("untagged");
  });
});
