/**
 * URL construction for data assets.
 *
 * Two hazards this exists to defuse:
 *  1. `import.meta.env.BASE_URL` is "/" locally but "/<repo>/" under a subpath
 *     deploy. Naive string concatenation breaks one of those cases.
 *  2. DuckDB's HTTP filesystem runs inside a Web Worker, whose `location` is
 *     the worker script's URL -- not the page's. A page-relative URL therefore
 *     resolves against the wrong base. Every URL handed to DuckDB must be
 *     absolute.
 */
/**
 * Resolved on first use rather than at import time, and memoized after.
 * Otherwise merely importing this module -- or anything that imports it, which
 * includes the picture helpers -- requires a `window`, and the unit suite runs
 * in the node environment precisely because the logic under test is pure.
 */
let originBase = null;
const base = () => (originBase ??= new URL(import.meta.env.BASE_URL, window.location.href));

export const assetUrl = (path) => new URL(path, base()).href;

/**
 * Files under public/ are copied verbatim by Vite and get no content hash, so
 * cache-busting rides on a query param derived from the build.
 */
export const dataUrl = (name, version) =>
  assetUrl(`data/${name}`) + (version ? `?v=${encodeURIComponent(version)}` : "");

/**
 * The scanned source PDF for a record, served by the dev-only mount in
 * vite.config.js straight out of the sibling data repo (see /pdf/ there).
 * `pdf_path` is already repo-relative, so it IS the URL -- nothing is guessed.
 *
 * `page` is the volume page a pre-1974 order starts on. `#page=` is a PDF open
 * parameter, not a URL fragment the app resolves: a viewer that honours it
 * opens on the order, and one that does not opens at page 1, which is where an
 * unadorned link would have landed anyway.
 */
export const localPdfUrl = (pdfPath, page) =>
  pdfPath ? assetUrl(`pdf/${pdfPath}`) + (page ? `#page=${page}` : "") : null;
