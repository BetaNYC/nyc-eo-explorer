# nyc-eo-explorer

> 🚧 **Work in progress.** The explorer is usable today, but the corpus underneath it is still being refined — text quality, metadata, and coverage are all in motion upstream, and data shapes may change with them. Nothing here should yet be treated as a complete or authoritative record. [Issues](../../issues) and contributions welcome.

A fully static explorer for the [NYC mayoral executive orders corpus](https://github.com/BetaNYC/nyc-executive-orders)
— search, filter, and browse the full corpus in the browser, with **no server and no API**.

Queries run in the browser: [DuckDB-WASM](https://duckdb.org/docs/current/clients/wasm/overview)
executes real SQL over Parquet files served as static assets.

Vibe coded with [Claude](https://claude.ai) by [BetaNYC](https://beta.nyc).

**Deployed to GitHub Pages** from `main` by
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml): the corpus repo is
checked out alongside, the Parquet and picture crops are rebuilt from it, and the
whole thing is published as a static directory. Everything the page needs is served
from Pages except the scanned source PDFs, which are 1.1 GB of git-LFS files and are
read cross-origin instead — see "The source PDFs, side by side" below.

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

The corpus repo publishes executive orders as Markdown and JSON. That's the right
format for reading, diffing, and archiving, and the wrong one for searching 2,300
documents in a browser. This app translates it into something queryable, then does
the querying client-side.

**1. Build.** `npm run data` reads the sibling corpus repo and rewrites it as
[Parquet](https://parquet.apache.org/) — a compact columnar format DuckDB can read
efficiently — in `public/data/`. Those files are derived artifacts: gitignored, and
rebuilt whenever the corpus changes upstream.

| File                         | Size    | Contents                                          |
| ---------------------------- | ------- | ------------------------------------------------- |
| `eo_meta.parquet`            | ~80 KB  | One row per order: dates, mayor, title, flags     |
| `eo_text.parquet`            | ~1.7 MB | The full text of every order (~9 MB, compressed)  |
| `supersession_edges.parquet` | ~4 KB   | Which orders revoked or amended which             |
| `entity_mentions.parquet`    | ~230 KB | Where each agency is named, with exact offsets    |
| `entities.parquet`           | ~100 KB | One row per agency: names, registry facts, counts |
| `pictures.json`              | ~150 KB | Seals and signatures clipped out of the old scans |
| `manifest.json`              | ~1 KB   | Counts, year range, checksums                     |

Metadata and text are split because most of the app never needs the text. Browsing,
filtering, and the charts run off the 80 KB file; the megabyte of text is fetched the
first time you search or open an order.

**2. Serve.** Everything is a static file. There is no server, no API, and no
database to run — `npm run build` produces a directory, and GitHub Pages hosts it.

**3. Query.** [DuckDB-WASM](https://duckdb.org/docs/current/clients/wasm/overview)
runs in the browser and executes real SQL against those Parquet files, pulling them
over HTTP a chunk at a time rather than downloading everything up front. Every
search, facet count, and chart in the app is a SQL query. The engine is ~7 MB
compressed, which is the largest single cost in the design and the reason it loads
once and is shared across the whole app.

The one thing not served from Pages is the scanned source PDFs — 1.1 GB of git-LFS
files, too large to host there. Those are read from `media.githubusercontent.com`,
pinned to the corpus commit the site was built from.

### Search

The corpus is heavily OCR'd — about a fifth of orders are flagged as noisy, and 67
have no recoverable text at all — so a word index is the wrong default:
`Adminstration` will never match `administration`. Three modes are offered as equals
instead.

| Mode                | What it does                               | Notes                     |
| ------------------- | ------------------------------------------ | ------------------------- |
| **Exact** (default) | Plain substring match, case-insensitive    | Always available          |
| **Regex**           | Full regex — e.g. `admin[il1]strat[il1]on` | For working around OCR    |
| **Relevance**       | BM25 ranking via DuckDB's full-text search | Opt-in; downloads ~480 KB |

Relevance needs an extension that isn't built into duckdb-wasm, so selecting it
fetches one at runtime. If that fails, search falls back to the other two modes
rather than breaking.

### Reading an order

The detail view shows the transcribed text next to the scan it came from. The text is
Markdown-ish — the OCR emits headings, emphasis, and HTML tables — so it renders
through `marked` and is sanitized with `DOMPurify`, with a **Rendered / Raw** toggle
because anyone checking a transcription against the scan needs the characters as
stored.

The scan is displayed with pdf.js's own viewer component, which brings continuous
scroll, text selection, and fit-to-width along with it. Pre-1974 orders are a few
pages inside a scanned bound volume, so the viewer opens on the order's first page
(page 49 of 334, not page 1) and the toolbar lists the specific pages that order
occupies — they aren't always contiguous, since the volumes have blank versos.

Those old volumes are also where `pictures.json` comes from: the OCR tags regions of
each page as pictures — city seals, mayoral signatures — and upstream clips them out
of the scans, since none of it survives in the text. The build matches each clip to
whichever order was printed on that page. The **Pictures tab** turns that around and
searches by text to show images: look up `robert moses` and you get the seals and
signatures from the three orders that name him.

### Agencies

The corpus repo also publishes `corpus/mentions.json` — the output of its `lineage/`
scan, which reads every order looking for the name of a city agency. The **Agencies
tab** is that data: 2,345 bodies named across 23,756 mentions, each one linking to
every order that names it.

Two passes produce it, and the difference between them is on screen everywhere:

- **Confirmed** — the name matched [BetaNYC's agency
  registry](https://github.com/BetaNYC/ny-gov-web-registry). 178 agencies, carrying
  the registry's acronym, alternate and former names, classification, website, and
  the agency's own description of itself. The former names are the useful half: the
  registry records "Office of Emergency Management" against NYCEM and "Department of
  Education" against NYC Public Schools, which is how a 2005 order reaches the agency
  that exists today.
- **Proposed** — the phrase only _looks_ like an agency name. Not reviewed by anyone.

Both are shown, and that is the whole point. The registry lists agencies that exist
**today** and marks all 317 of them active, so it cannot name a body that was shut
down. The Board of Estimate, the Bureau of the Budget, DoITT — every one of them is a
Proposed name, and every one of them is most of the history. Hiding them would leave
a clean list with nothing in it worth reading. The cost is that pattern matching also
proposes junk, which is why the index hides names seen in fewer than three orders by
default and every row carries its badge.

**An agency page** shows the run of orders that name it, per year, with the mayor of
each year underneath. Where a run starts and stops is real evidence: the Board of
Estimate runs 1946 to 1990 and then stops, because it was abolished in 1990. It is
not proof — the Charter and Local Law also create and abolish agencies, and neither
is in this corpus.

**Cap the order size** to keep a handful of orders from pairing everything with
everything. Half the orders name one or two agencies, but the tail runs to 167 in a
single order — delegations of authority that list the whole city government. One
such order manufactures 13,861 agency pairs on its own, so a few of them dominate
every graph and make co-mention look like a property of the corpus rather than of
the orders. "Ignore orders naming more than N agencies" drops them, and it narrows
the order list to match — the graph and the list are always built from the same set.

Under a cap each agency is recounted **within** it. Using the corpus-wide
`eo_count` as the denominator would divide a capped numerator by an uncapped total
and quietly shrink every share on the page.

**The graph is also the filter.** One click on a ring node narrows the order list
to those naming that agency _as well_; click more to narrow further. Anything that
would leave no orders greys out before you click it, so a dead end is visible rather
than discovered — and the whole filtered view is a link, since the selection lives in
the URL hash like everything else. Double-click opens an agency's own page. On the
Board of Estimate, adding the Comptroller and the City Council cuts 142 orders to 18,
and almost every one is budget appropriations — which is what those three bodies did
together.

**"Named alongside"** is the co-mention graph: of every order naming either agency,
the share that names both ([Jaccard](https://en.wikipedia.org/wiki/Jaccard_index)).
Not a plain count, because "Office of the Mayor" is on the letterhead of 2,449 orders
and would top all 2,345 graphs. Lift was tried first and broke the other way — a
4-order fragment outranked the Comptroller on the Board of Estimate — so the measure
has to have a large denominator at _both_ ends. **Most shared** switches to the plain
count, which is worth seeing precisely because it shows what the default is
suppressing.

On an order, **Agencies named in this order** lists them in the order they appear,
and the **Names marked** view of the text marks each one where the scan found it. The
scan records character offsets into `full_text` and proves `full_text[start:end] ==
text` for all 23,504 finds, so that view is a slice at known positions rather than a
second search — which is why it also marks names wrapped across a line break, as OCR
of a PDF constantly produces.

### Gotchas worth knowing

- **Column types are written explicitly in the build script.** EO numbers are
  strings — `"001"`, `"23"`, `"1.37"` — and left to guess, DuckDB turns `"001"` into
  `1` and quietly loses data.
- **The pre-1974 corpus is optional.** Upstream is still OCR'ing those volumes; the
  build picks them up when they appear. Don't assume an `eo_id` is `EO` or `EEO` —
  that era also has `1951-EM-001`, `1972-AM-007`, and others.
- **Cross-origin range requests need help.** CORS hides `Accept-Ranges` from pdf.js,
  so without the custom transport in `PdfViewer` it downloads entire 49 MB volumes
  before showing a page.
- **The agency data is optional too.** No `corpus/mentions.json` upstream means no
  Agencies tab, rather than a failed build. Regenerate it there with
  `python lineage/run_scan.py --mentions-out corpus/mentions.json` and commit it.
- **A bare acronym is not an agency name.** The upstream pattern pass only proposes
  phrases built on a head-word (Department, Office, Board…), so "DoITT" written on
  its own is never proposed. The word is still in the orders — Search finds it.

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
plain files from `public/`, so dev and production are the same code path. The one
asset that is not a plain file — the scans, which are too large to be one — is the
only place the two diverge, and `src/paths.js` is the single seam where that
happens.

Chart colors were validated for colorblind separation and contrast rather than
chosen by eye. `text_quality` uses a sequential ramp because it is an _ordered_
scale, not a set of identities.

## Want to help?

This is early-stage, openly built civic infrastructure — contributions to the app,
its tests, or the corpus it reads are all welcome.

```bash
git clone https://github.com/BetaNYC/nyc-eo-explorer.git && cd nyc-eo-explorer
npm install && npm run dev     # builds the Parquet artifacts first if they're stale
npm test                       # unit + real-SQL integration
```

You need the [corpus repo](https://github.com/BetaNYC/nyc-executive-orders) checked
out as a sibling directory (see [Requirements](#requirements)) — that is where the
data comes from. Work on the **data itself** — OCR text, titles, metadata, coverage
gaps — belongs upstream in that repo, which has its own review queue and open
issues.

**The one hard rule carries over from upstream:** never invent or guess at content.
This app displays a public record; an empty or flagged field is correct, a plausible
substitute is a bug. Nothing in the UI may present derived or guessed data as if it
came from the source document.

Questions, ideas, or a bug you've spotted: [open an issue](https://github.com/BetaNYC/nyc-eo-explorer/issues) or hello@beta.nyc.

## Part of BetaNYC's civic data tools

This explorer is one of a family of free, open civic data assets [BetaNYC](https://beta.nyc) builds and stewards:

- [`nyc-executive-orders`](https://github.com/BetaNYC/nyc-executive-orders) — the corpus this app reads: an open, machine-readable archive of NYC mayoral executive orders, 1974–present.
- [`ny-gov-web-registry`](https://github.com/BetaNYC/ny-gov-web-registry) — which NY government entities exist, and where they live on the web.
- [`ny-gov-web-archiver`](https://github.com/BetaNYC/ny-gov-web-archiver) — the throttled Wayback Machine harvester behind the corpus's historical backfills.
- [`nyc-boundaries`](https://github.com/BetaNYC/nyc-boundaries) — NYC administrative boundaries, mapped and queryable.
- Seven MCP servers giving AI agents direct access to NYC/NYS civic data: [Council legislation](https://github.com/BetaNYC/nyc-council-mcp), [City Record](https://github.com/BetaNYC/nyc-record-mcp), [Checkbook spending](https://github.com/BetaNYC/nyc-checkbook-mcp), [311](https://github.com/BetaNYC/nyc-311-mcp), [Charter/Code/Rules](https://github.com/BetaNYC/nyc-charter-laws-rules), [NYS legislation](https://github.com/BetaNYC/nys-openlegislation-mcp), and the [Council budget](https://github.com/BetaNYC/New-York-City-Budget).

## AI use in this project

BetaNYC uses AI tools openly and with human accountability. This repository was built by AI agents (Anthropic's Claude) working under the direction and review of BetaNYC staff — the app code was written by AI, and the scope and design decisions are human-made.

One commitment about the content: **the executive orders this app displays are not AI-generated.** Order text is served verbatim from the corpus, which retrieves it from official City sources and the Internet Archive — never summarized, paraphrased, or invented. The app renders and searches that text; it does not rewrite it. Where the corpus is incomplete or its OCR is imperfect, the UI says so rather than smoothing it over.

Questions about our approach: hello@beta.nyc.

## License

- **Code** (this repository): [MIT](LICENSE) © 2026 BetaNYC — use and modify freely with attribution preserved.
- **The data it displays** — the corpus, the source scans, and the picture crops — lives in [`nyc-executive-orders`](https://github.com/BetaNYC/nyc-executive-orders) under [Creative Commons Attribution-ShareAlike 4.0](https://github.com/BetaNYC/nyc-executive-orders/blob/main/LICENSE-DATA): reuse and adapt with credit to BetaNYC, and share adaptations under the same license.

The underlying executive orders are public records of the City of New York; these licenses cover this tooling and the compilation it reads.

## A note on sources

Documents shown here are reproductions of public records, retrieved from official City sources and the [Internet Archive](https://archive.org) under its access guidelines. Text of the oldest orders is OCR output — faithful to the scan, not perfected — and is not legal advice; verify against the source PDF, which every record links to.
