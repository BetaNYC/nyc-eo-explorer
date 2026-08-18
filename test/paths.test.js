import { afterEach, describe, expect, it, vi } from "vitest";

import { localPdfUrl, mediaBase } from "../src/paths.js";

/**
 * Only the media branch is covered here, and that is deliberate: the other
 * branch goes through `assetUrl`, which needs a `window`, and this suite runs in
 * the node environment so that importing the path helpers stays free. The media
 * branch touches no DOM at all.
 */
const SHA = "780cf6a413fcb6dc6e8b961cb27dcc6815c1bda1";
const HOST = `https://media.githubusercontent.com/media/BetaNYC/nyc-executive-orders/${SHA}`;

afterEach(() => vi.unstubAllEnvs());

describe("localPdfUrl, deployed", () => {
  it("resolves a repo-relative pdf_path against the media base", () => {
    vi.stubEnv("VITE_MEDIA_BASE", `${HOST}/`);
    expect(localPdfUrl("pdfs/2020/2020-EEO-105.pdf")).toBe(`${HOST}/pdfs/2020/2020-EEO-105.pdf`);
  });

  // The whole reason paths.js normalizes the base. `new URL("pdfs/x", ".../<sha>")`
  // resolves against the PARENT of <sha> and drops the commit, so every scan
  // would 404 -- and only on a deploy whose base was written without the slash.
  it("keeps the commit when the base has no trailing slash", () => {
    vi.stubEnv("VITE_MEDIA_BASE", HOST);
    expect(localPdfUrl("pdfs/2020/2020-EEO-105.pdf")).toContain(`/${SHA}/pdfs/`);
  });

  it("appends the volume page as a PDF open parameter", () => {
    vi.stubEnv("VITE_MEDIA_BASE", `${HOST}/`);
    const stem = "sources/gpp/volumes/1970-01-01_1971-12-09_Lindsay_Orders.pdf";
    expect(localPdfUrl(stem, 49)).toBe(`${HOST}/${stem}#page=49`);
  });

  it("has no URL for a record with no PDF", () => {
    vi.stubEnv("VITE_MEDIA_BASE", `${HOST}/`);
    expect(localPdfUrl(null)).toBeNull();
    expect(localPdfUrl(undefined, 3)).toBeNull();
  });

  it("reports no media base when it is unset, which is what dev keys off", () => {
    vi.stubEnv("VITE_MEDIA_BASE", "");
    expect(mediaBase()).toBeNull();
  });
});
