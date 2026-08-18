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
 * Where the scanned source PDFs are read from, or null for the dev mount.
 *
 * The scans are 1.1 GB of git-LFS files in the data repo, so a deployed build
 * cannot carry them and GitHub Pages will not serve an LFS pointer. It reads
 * them from media.githubusercontent.com instead -- the one GitHub host that
 * resolves a pointer to its content -- pinned by the deploy to the exact commit
 * the rest of the build came from. Unset in dev, where vite.config.js's /pdf/
 * mount serves the sibling checkout directly.
 *
 * Read through a function rather than at module scope: this module has to stay
 * importable in the node test environment, where there is no `window`.
 */
export const mediaBase = () => import.meta.env.VITE_MEDIA_BASE || null;

/**
 * The scanned source PDF for a record. `pdf_path` is already repo-relative, so
 * it IS the URL under either base -- nothing is guessed.
 *
 * `page` is the volume page a pre-1974 order starts on. `#page=` is a PDF open
 * parameter, not a URL fragment the app resolves: a viewer that honours it
 * opens on the order, and one that does not opens at page 1, which is where an
 * unadorned link would have landed anyway.
 */
export const localPdfUrl = (pdfPath, page) => {
  if (!pdfPath) return null;
  const media = mediaBase();
  // The trailing slash is forced, not assumed. `new URL("pdfs/x.pdf", ".../<sha>")`
  // resolves against the PARENT of `<sha>` and quietly drops the commit from the
  // URL -- every PDF would 404, and only on a deploy where someone wrote the
  // base without it.
  const href = media
    ? new URL(pdfPath, media.endsWith("/") ? media : `${media}/`).href
    : assetUrl(`pdf/${pdfPath}`);
  return href + (page ? `#page=${page}` : "");
};
