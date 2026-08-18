import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Serve the scanned source PDFs from the sibling data repo, LOCAL DEV ONLY:
 *
 *   /pdf/<repo-relative>.pdf    the scanned source PDFs   <repo root>/
 *
 * They do not belong in public/: 2,305 git-LFS files and 1.1 GB, which is not
 * something to copy into a build, and well past what GitHub Pages will host. A
 * deployed build reads them cross-origin from media.githubusercontent.com
 * instead (VITE_MEDIA_BASE, see src/paths.js), which is the one GitHub endpoint
 * that resolves an LFS pointer to its content. This mount is what keeps dev
 * working offline and without that round trip.
 *
 * The crops used to be mounted here too. They are now copied into public/pics/
 * by `npm run data` and served as ordinary site files, in dev and production
 * alike -- 53 MB of JPEG is small enough to just be part of the site.
 *
 * Override with EO_REPO_DIR=/path npm run dev.
 */
const repoRoot = path.resolve(HERE, process.env.EO_REPO_DIR || "../nyc-executive-orders");

// `pdf_path` on a corpus record is repo-relative (`pdfs/1974/1974-EO-001.pdf`,
// `sources/gpp/volumes/<stem>.pdf`), so the PDF mount is rooted at the repo and
// the record's own path is the URL. Nothing rewrites or guesses a location.
const MOUNTS = [{ prefix: "/pdf/", root: repoRoot, ext: ".pdf", type: "application/pdf" }];

const dataRepoMount = () => {
  const serve = (req, res, next) => {
    const mount = MOUNTS.find((m) => req.url?.startsWith(m.prefix));
    if (!mount) return next();
    const rel = decodeURIComponent(req.url.slice(mount.prefix.length).split("?")[0]);
    const file = path.resolve(mount.root, rel);
    // One extension, and nothing outside the mount root: this middleware reads
    // arbitrary paths off a URL, so traversal is the whole risk. The PDF mount
    // is rooted at a whole repo, which makes the check load-bearing rather than
    // belt-and-braces.
    if (!file.startsWith(mount.root + path.sep) || !file.endsWith(mount.ext)) {
      res.statusCode = 403;
      return res.end("forbidden");
    }
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      res.statusCode = 404;
      return res.end("not found");
    }

    // Range support is load-bearing for the PDFs, not a nicety: a bound volume
    // scan is ~66 MB, and without it the browser's viewer downloads all of it
    // before it can show page 9 of 400. With it, it fetches the trailer, the
    // xref and the pages asked for.
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    let start = 0;
    let end = size - 1;
    if (match) {
      const [, from, to] = match;
      // "bytes=-500" means the LAST 500 bytes, which is how a PDF viewer finds
      // the trailer. Reading it as "from 0 to 500" serves the wrong end of the
      // file and the viewer reports a corrupt document.
      if (from === "") start = Math.max(0, size - Number(to));
      else {
        start = Number(from);
        if (to !== "") end = Math.min(end, Number(to));
      }
      if (start > end || start >= size) {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${size}`);
        return res.end();
      }
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    }
    res.setHeader("Content-Type", mount.type);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", end - start + 1);
    if (req.method === "HEAD") return res.end();

    fs.createReadStream(file, { start, end })
      .once("error", () => res.destroy())
      .pipe(res);
  };
  // The bodies are braced deliberately: an arrow returning `middlewares.use()`
  // hands Vite a truthy return value, which it takes for a post-hook and calls
  // with no arguments -- and the dev server dies before it listens.
  return {
    name: "eo-data-repo-files",
    configureServer(server) {
      server.middlewares.use(serve);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve);
    },
  };
};

export default defineConfig({
  // "/" locally; "/<repo>/" if this is ever served from a GitHub Pages project
  // site. Same convention as the sibling repo's qa-ui.
  base: process.env.VITE_BASE || "/",
  plugins: [react(), dataRepoMount()],
  // qa-ui owns 5274.
  server: { port: 5275, open: true },
  optimizeDeps: {
    // duckdb-wasm ships pre-bundled ESM that references sibling .wasm/.worker
    // assets by relative path. Running it through esbuild's dependency
    // pre-bundling rewrites those references and breaks the ?url asset graph.
    exclude: ["@duckdb/duckdb-wasm"],
    // apache-arrow (duckdb-wasm's only dependency) uses BigInt literals, which
    // esbuild rejects below esnext.
    esbuildOptions: { target: "esnext" },
  },
  build: {
    target: "esnext",
    // The engine is a 34 MB .wasm. Chasing the chunk-size warning is pointless.
    chunkSizeWarningLimit: 40_000,
  },
});
