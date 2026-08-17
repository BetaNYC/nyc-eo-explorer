# nyc-eo-explorer

A fully static explorer for the [NYC mayoral executive orders corpus](https://github.com/BetaNYC/nyc-executive-orders)
— search, filter, and browse the full corpus in the browser, with **no server and no API**.

Queries run in the browser: [DuckDB-WASM](https://duckdb.org/docs/current/clients/wasm/overview)
executes real SQL over Parquet files served as static assets.

> **Local development only, for now.** There is no deploy pipeline yet — the build
> output is a plain static directory, so the hosting decision (GitHub Pages,
> Cloudflare Pages, anything else) stays open.

## Requirements

- **Node ≥ 20**
- The data repo checked out **as a sibling directory**:

```
<parent>/
  nyc-executive-orders/   <- the corpus
  nyc-eo-explorer/        <- this repo
```

That layout is assumed by the data build. Override it with `EO_CORPUS_DIR=/path/to/corpus`.

## Getting started

```bash
npm install
npm run dev          # http://localhost:5275
```

`predev` builds the Parquet artifacts automatically if they are missing or if the
corpus changed upstream, so those two commands are the whole setup. No Python, no
`uv`, no DuckDB install — the data build uses the `@duckdb/node-api` npm package.

| Command                             | What it does                                         |
| ----------------------------------- | ---------------------------------------------------- |
| `npm run dev`                       | Dev server (rebuilds data first if stale)            |
| `npm run data`                      | Force a data rebuild                                 |
| `npm run build` / `npm run preview` | Production build / serve it                          |
| `npm test`                          | Vitest — pure functions **and** real-SQL integration |
| `npm run lint` / `npm run format`   | ESLint / Prettier                                    |

## How it works

### Data

`scripts/build-data.mjs` reads the sibling repo's `corpus/*.json` and writes five
files into `public/data/` (gitignored — they are derived artifacts):

| File                         | Size    | Contents                                                                    |
| ---------------------------- | ------- | --------------------------------------------------------------------------- |
| `eo_meta.parquet`            | ~80 KB  | The 21 locked frontmatter fields + `char_count` + page provenance. No text. |
| `eo_text.parquet`            | ~1.7 MB | `eo_id` + full text. ~9 MB of text, zstd-compressed.                        |
| `supersession_edges.parquet` | ~4 KB   | Flat `{actor, target, verb, source, partial}` edges.                        |
| `pictures.json`              | ~150 KB | Phase E picture crops grouped by `eo_id`. Empty if the side-car hasn't run. |
| `manifest.json`              | ~1 KB   | Counts, year range, file digests, `generated_at`.                           |

The **meta/text split is the loading strategy**: the browse UI, all facets, and
every analytics chart run off the 50 KB file, and the megabyte of text is not
fetched until you actually search or open an order.

Three details in the builder are load-bearing rather than incidental:

- **Column types are declared, never inferred.** `admin_note` is 100% NULL today,
  `in_effect` has no `true` values, and `number` holds `"001"`, `"23"` and `"1.37"`
  alike — inference gets all three wrong, and `"001"` becoming `1` is silent
  data loss. The type table mirrors `build_corpus.FRONTMATTER_FIELDS` upstream.
- **`full_text_raw` is stored as NULL when identical to `full_text`** (true for
  ~87% of records). The app coalesces on read.
- **`ROW_GROUP_SIZE 512` on the text file.** DuckDB's default is 122,880 rows, which
  would put the whole corpus in one row group and make ranged reads prune nothing.

Pre-1974 inputs (`eo_pre1974.json`, `pre1974_provenance.json`) are **optional** —
that corpus is still being produced by the upstream Phase E OCR pipeline. The
builder picks them up automatically when they appear, and nothing parses `eo_id`
as `EO|EEO`, because the pre-1974 era introduces `1951-EM-001`, `1972-AM-007`,
and other series.

**Page provenance.** A pre-1974 order is a few pages of a 400-page bound volume
scan, so `eo_meta` carries `source_page_start` (INTEGER) and `source_pages`
(INTEGER[]), joined in from `pre1974_provenance.json` — the locked frontmatter
has no room for them upstream, by design. The list, not a first..last range, is
authoritative: 153 records skip blank versos, so `1946-EO-D0916` is pages 44, 46,
48, 50 and a range would claim three pages it is not on. Both columns are NULL
for all 2,291 orders from 1974 on, which each have a PDF of their own. The detail
view shows the list and points the source link at `…#page=<start>`.

`source_page_total` joins on alongside them — how many pages the whole volume
has, so the detail view can say "pages 44, 46, 48, 50 of 204 in the scanned
volume". It is counted from the committed per-page OCR output (one
`page_NNNN.json` per page, blanks included, so the count is the PDF's page count
— 204 either way on the O'Dwyer volume), because this script has to run without
the git-LFS PDFs present. Not to be confused with `page_count`, which is the
**order's** length: `1946-EO-D0916` is 4 pages inside that 204-page volume.

**Pictures (local dev only).** Upstream's `scripts/run_picture_clips.py` cuts every
region the OCR tagged `Picture` back out of the volume PDFs — city seals, mayoral
signatures, the odd real figure — all of which the corpus text throws away. The
builder joins that side-car's `vlm-pics/manifest.json` to page provenance on
`(pdf_path, page)` and writes `pictures.json` as `eo_id → [{image, tag, page}]`,
so an order gets the pictures that were physically on its pages. A page shared by
two orders gives its crops to both; crops on index and furniture pages belong to
no record and are counted as orphans in the build log rather than dropped
silently. The `seal` / `sig` tags are **upstream heuristics on shape, size,
position and ink density**, not model output — dots.ocr has one `Picture`
category and nothing finer — so the detail view labels them as guesses and keeps
`null` ("untagged") as a distinct third answer.

**The Pictures tab** goes the other direction from that panel: instead of "what
is on this order's pages", it answers "show me the crops from every order whose
text matches" — search `robert moses` and you get the seals and signatures from
each of the three orders that name him. That join is the feature, because the
text lives on the order and the pixels live on the page.

It is real SQL like everything else. `pictures.json` is nested (`eo_id → [crop]`),
so `ensurePictures()` flattens it in JS and hands DuckDB one newline-delimited
record per crop; the resulting `pictures` table joins onto whatever
`buildSearchQuery` already matched. Doing it that way rather than intersecting
`eo_id`s in JS is what makes the counts exact and the type facet possible — a
client-side join would need a row cap and would under-report as the corpus grows.
The tab shares `q`, the Exact/Regex/Relevance toggle and the facet rail with the
Search tab, so crossing between them keeps your query; the rail's counts join
`pictures` there, or it would offer 400 Giuliani orders and deliver no crops.
The type filter keeps `null` as a **third** option ("untagged", 469 of 2,137),
not as a synonym for "neither seal nor signature", and each crop opens full size
— a signature is a wide ribbon and illegible at thumbnail height.

The crops themselves are gitignored pixels in the sibling repo, so they are
**not** copied into `public/`: a dev-server mount in `vite.config.js` serves them
at `/pics/<volume>/<file>.png` straight out of `../nyc-executive-orders/vlm-pics`
(`EO_PICS_DIR=/path` to point elsewhere). A build has no such mount, so a
deployed page shows each tile's alt text until the crops are given a home of
their own — which is why the whole picture feature, the tab included, is local
dev only for now. Rebuild after clipping another volume — `npm run dev` does it for you,
the picture manifest is one of the staleness triggers `ensure-data.mjs` watches.

**The source PDFs, side by side (local dev only).** The same mount serves the
scans at `/pdf/<repo-relative path>` rooted at the data repo itself
(`EO_REPO_DIR=/path` to point elsewhere), so a record's own `pdf_path` is the
URL and nothing guesses a location. The detail view's **Text only / Side by
side** toggle puts the scan next to the transcription, in **pdf.js's own viewer
component** (`pdfjs-dist/web/pdf_viewer.mjs` — the viewer Firefox's built-in
reader is built on). It arrives on the order's first page: page 49 of a
334-page volume, not page 1 of it.

Using that component rather than an `<iframe>` or a hand-rolled canvas loop is
the whole design. It brings continuous scroll, lazy per-page rendering, HiDPI
canvases, text selection and fit-to-width for free, and it fires `pagechanging`,
so the pager's page number **tracks scrolling** — an `<iframe>` can't do that
(its scroll position is a plugin's, unreadable from the page) and a hand-rolled
one has to reimplement it. It also takes page geometry from each page's own
MediaBox, which matters more than it sounds: these are photographs of a bound
book, and the O'Dwyer volume has **117 distinct page sizes across 204 pages**.
There is no document-level page size to lean on.

The toolbar around it is thin on purpose: `‹ Page [n] of N ›`, a zoom stepper
whose middle button is the fit-width reset, and a chip per page **this order**
occupies — a volume-derived order is a handful of scattered pages, not a range.
pdf.js is code-split (`lazy()`), so its ~600 KB and 1.2 MB worker load when
someone opens the pane, not on every page load.

One non-obvious thing, and the source of a fixed bug worth not reintroducing:
**the opening jump waits for `viewer.pagesPromise`.** At `pagesinit` pdf.js has
built every page view from page 1's viewport as a placeholder, and only swaps in
each page's real geometry as `getPage` resolves (`pdf_viewer.mjs`, the loop
after `#onePageRenderedOrForceFetch`). On a volume with 117 different page sizes
that means jumping at `pagesinit` scrolls by page-1-sized placeholders — landing
on the wrong page, at a scale the canvases then resize out from under. Waiting,
then re-applying `page-width`, fixes both. The zoom button also reads "Fit"
rather than a percentage while fitting: pdf.js scales relative to 72 dpi points,
so an exact page-width fit reports as ~57% and reads like a bug.

Both mounts refuse anything outside their root or with the wrong extension —
they read paths off a URL, and the PDF mount is rooted at a whole repository.
The PDF mount also answers **range requests**, which is load-bearing rather than
polite: a bound volume is ~66 MB, and without ranges the viewer downloads all of
it before showing anything. 3,184 git-LFS PDFs are not something to copy into a
build, so a deployed page has no side-by-side pane — the DORIS links in the
metadata table still go to the same documents.

### The engine

DuckDB-WASM is bundled locally (Vite `?url` imports), not loaded from a CDN, so
it works offline and on any host. Only the `eh` bundle ships: `coi` needs
COOP/COEP headers that GitHub Pages cannot set, and `mvp` costs another 39 MB to
serve pre-2022 browsers.

The engine is **6.8 MB brotli / 7.6 MB gzip** (34 MB raw) — the single largest
cost in the design. It is therefore instantiated as a module-scope singleton
outside React's lifecycle (`src/duckdb/store.js`), read via `useSyncExternalStore`.
A `useEffect` that instantiates on mount and terminates on cleanup would
instantiate _twice_ under StrictMode and race a dead worker.

### Search — three modes, deliberately peers

The corpus is heavily OCR'd -- roughly a fifth of orders are flagged
`needs-review` or `minor-noise`, and 67 have no recoverable text at all -- so a
stemmed word index is the wrong default: `Adminstration` will never match
`administration`.

| Mode                | How                                                         | When it's available       |
| ------------------- | ----------------------------------------------------------- | ------------------------- |
| **Exact** (default) | `contains()` over a precomputed lowercase column            | As soon as the text loads |
| **Regex**           | `regexp_matches(..., 'is')` — e.g. `admin[il1]strat[il1]on` | Same                      |
| **Relevance**       | BM25 via DuckDB's `fts` extension                           | Opt-in, see below         |

**Note on Relevance:** `fts` is _not_ statically linked into duckdb-wasm. Selecting
that mode triggers an `INSTALL`, which fetches ~480 KB from `extensions.duckdb.org`
at runtime. That is why it is opt-in rather than the default, and why a failure to
load degrades to the scan modes instead of breaking search.

DuckDB's FTS has no `snippet()` (unlike SQLite FTS5), so excerpts and highlighting
are built in JS (`src/search/snippet.js`) over only the rows on screen. Segments
are returned as `{text, hit}` data and rendered as text nodes — never as an HTML
string — so OCR'd text containing a literal `<script>` is displayed, not executed.

### Rendering an order's text

The body is Markdown-ish, not plain text. The Phase E VLM OCR emits `#`/`##`
headings and emphasis (hundreds of orders have headings), and **raw `<table>`
HTML** for tabular regions of a scan such as library date stamps. So the detail
view renders it with `marked` + `DOMPurify` (`src/markdown.js`) and offers a
**Rendered / Raw** toggle — the raw view matters because this is OCR output, and
anyone checking a transcription against the scan needs the characters as stored.

Two things there are load-bearing rather than stylistic:

- **`breaks: true`**, unlike `qa-ui`'s renderer. qa-ui joins page elements with
  blank lines; this corpus has ~30x more newlines than blank-line pairs, so
  without it a numbered clause list and a signature block collapse into one
  run-on paragraph. In a legal document the line structure is content.
- **Raw `<table>` blocks are padded with blank lines before parsing.** Under
  CommonMark an HTML block runs until the next _blank_ line, so a table would
  otherwise swallow the entire rest of the document and emit it verbatim.

HTML must be allowed through (the tables are real HTML) and therefore must be
sanitized — this is untrusted scan output. Tests cover script tags, inline event
handlers, `javascript:` URLs, and iframe/object embeds.

## Testing

```bash
npm test
```

- **Unit tests** cover the pure logic: the SQL builder, the query parser, hash-state
  round-tripping, and snippet extraction. These are the modules where a bug is
  silent — a wrong result set looks like a plausible result set.
- **`test/sql-integration.test.js`** runs every SQL shape the app can emit against a
  real DuckDB and the real Parquet. Counts are derived from the manifest, never
  hardcoded — the corpus grows as Phase E volumes land — so the assertions are
  invariants (the parts sum to the whole, a facet partitions the corpus). A unit
  test on a string builder can only prove it produced the string you expected —
  not that the string compiles.
  It skips itself if `public/data` has not been built.

Not covered: the browser worker, `?url` asset resolution, and the FTS extension
load. Those need a real browser; if they earn it, add Playwright as a separate
`test:e2e`.

## Conventions

Deliberately mirrors `qa-ui/` in the data repo so the two read as one project:
React 18.3 + Vite 6, plain `.jsx` (no TypeScript), one hand-written `styles.css`
with a CSS-variable design system, no UI library, hooks only, and **no router** —
deep links ride the URL hash.

One deliberate divergence: `qa-ui` serves its data through dev-server middleware,
which means its `npm run build` produces a non-functional bundle. This app reads
plain files from `public/`, so dev and production are the same code path.

Chart colors were validated for colorblind separation and contrast rather than
chosen by eye. `text_quality` uses a sequential ramp because it is an _ordered_
scale, not a set of identities.
