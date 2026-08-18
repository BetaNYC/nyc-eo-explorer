import * as pdfjs from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { EventBus, PDFLinkService, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import { useEffect, useRef, useState } from "react";

import { mediaBase } from "../paths.js";

import "pdfjs-dist/web/pdf_viewer.css";

/**
 * The source scan, in pdf.js's own viewer component.
 *
 * `pdfjs-dist/web/pdf_viewer.mjs` is the viewer Firefox's built-in reader is
 * built on, and it already does everything this pane needs: continuous scroll,
 * lazy per-page rendering, HiDPI canvases, text selection, fit-to-width, and --
 * the reason the browser's <iframe> viewer had to go -- a `pagechanging` event,
 * so the page number tracks SCROLLING and not just the pager buttons.
 *
 * It takes page geometry from each page's own MediaBox, which matters more here
 * than it looks: these are photographs of a bound book, and the O'Dwyer volume
 * has 117 distinct page sizes across its 204 pages. There is no "document page
 * size" to lean on, and anything assuming one would drift down the volume.
 *
 * The worker is bundled locally through Vite's `?url`, like the DuckDB engine
 * and for the same reason: no CDN, works offline, works on any host.
 */
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/**
 * Range requests against media.githubusercontent.com, which pdf.js will not
 * make for itself.
 *
 * The host honours ranges perfectly well -- it answers 206 with a correct
 * Content-Range. What it does not do is send `access-control-expose-headers`,
 * and `Accept-Ranges` is not one of the seven response headers CORS exposes by
 * default. So `validateRangeRequestCapabilities` (pdf.mjs) reads null, decides
 * the server has no range support, and streams the whole file: 49 MB before the
 * first page of a bound volume paints, every time one is opened.
 *
 * Supplying a transport skips that negotiation entirely -- pdf.js asks this
 * object for byte ranges and never inspects a header. We can assert what the
 * detection could not observe because we know the host: the ranges are real.
 *
 * `Content-Length` IS CORS-safelisted, so the one thing we do have to discover
 * -- how long the file is -- can still be read off a HEAD.
 */
class MediaRangeTransport extends pdfjs.PDFDataRangeTransport {
  constructor(length, url) {
    // No initial chunk: pdf.js requests the ranges it wants as soon as the
    // transport is ready, starting from the trailer.
    super(length, new Uint8Array(0), false, null);
    this.url = url;
    this.controllers = new Set();
  }

  requestDataRange(begin, end) {
    const controller = new AbortController();
    this.controllers.add(controller);
    // An explicit `bytes=N-M` is a CORS-safelisted request header, so this stays
    // a simple request with no preflight. A SUFFIX range (`bytes=-500`) is not
    // safelisted and would be preflighted against an Access-Control-Allow-Headers
    // that does not list Range -- i.e. blocked. pdf.js computes absolute offsets
    // from the length above, so it never asks for one.
    fetch(this.url, {
      headers: { Range: `bytes=${begin}-${end - 1}` },
      signal: controller.signal,
    })
      .then((r) => r.arrayBuffer())
      .then((buf) => this.onDataRange(begin, new Uint8Array(buf)))
      .catch((e) => {
        // An abort is this component being torn down, not a failure worth
        // reporting; anything else leaves pdf.js waiting on a chunk forever, so
        // say so rather than hanging on a blank pane.
        if (e.name !== "AbortError") console.error(`PDF range ${begin}-${end} failed`, e);
      })
      .finally(() => this.controllers.delete(controller));
  }

  abort() {
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
  }
}

/**
 * `getDocument` arguments for a URL: a range transport when the scans are being
 * read cross-origin, and plain pdf.js defaults when they are not.
 *
 * Dev is served by the /pdf/ mount in vite.config.js, same-origin, where the
 * built-in negotiation works and is the thing worth exercising locally.
 */
async function documentArgs(src, signal) {
  if (!mediaBase()) return { url: src };
  // Strip `#page=`; it is an open parameter for a viewer, and sending it to
  // fetch would just miss the CDN cache.
  const url = src.split("#")[0];
  const head = await fetch(url, { method: "HEAD", signal });
  if (!head.ok) throw new Error(`${head.status} ${head.statusText}`);
  const length = Number(head.headers.get("Content-Length"));
  if (!Number.isInteger(length) || length <= 0) {
    // Nothing to range against. Falling back to a whole-file fetch is slow but
    // correct, which beats failing.
    return { url };
  }
  return { range: new MediaRangeTransport(length, url) };
}

export default function PdfViewer({
  src,
  initialPage = 1,
  orderPages = [],
  label,
  sourceUrl = null,
}) {
  const [page, setPage] = useState(initialPage);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const [error, setError] = useState(null);

  const containerRef = useRef(null);
  const viewerElRef = useRef(null);
  const viewerRef = useRef(null); // the PDFViewer instance
  // Read from inside the ResizeObserver below, which is created once per
  // document and would otherwise close over the first value of `fitWidth`.
  const fitWidthRef = useRef(fitWidth);
  fitWidthRef.current = fitWidth;
  // Whether the opening jump has finished; see the ResizeObserver below.
  const landedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setNumPages(0);
    landedRef.current = false;

    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus });
    const viewer = new PDFViewer({
      container: containerRef.current,
      viewer: viewerElRef.current,
      eventBus,
      linkService,
    });
    linkService.setViewer(viewer);
    viewerRef.current = viewer;

    // The two events this pane is really here for.
    eventBus.on("pagechanging", ({ pageNumber }) => setPage(pageNumber));
    eventBus.on("scalechanging", ({ scale: s }) => setScale(s));
    eventBus.on("pagesinit", async () => {
      const live = () => !cancelled && viewer === viewerRef.current && viewer.pdfDocument;
      // A first fit, so the document does not flash past at 100% on the way in.
      viewer.currentScaleValue = "page-width";

      const target = Math.trunc(Number(initialPage));
      if (!Number.isInteger(target) || target <= 1) {
        landedRef.current = true;
        return;
      }

      // WAIT before jumping. At `pagesinit` pdf.js has built every page view
      // from page 1's viewport as a placeholder, and only replaces each with
      // its own once `pagesPromise` resolves (pdf_viewer.mjs, the getPage loop
      // after #onePageRenderedOrForceFetch). Jumping before that scrolls by
      // page-1-sized placeholders, so on a volume whose pages are all
      // different sizes it lands short and the canvases resize underneath.
      await viewer.pagesPromise;
      if (!live()) return;

      // ORDER MATTERS, and getting it backwards is what put this on page 1:
      // a scale change scrolls back to `viewer._location`, which is only
      // updated from the SCROLL EVENT the jump fires -- asynchronously. Fit
      // first, land second, and nothing overwrites the landing.
      viewer.currentScaleValue = "page-width";
      if (target <= viewer.pagesCount) viewer.currentPageNumber = target;

      // And verify, because every bug in this component so far has been a
      // race: if anything did move us, put it back once.
      requestAnimationFrame(() => {
        if (live() && viewer.currentPageNumber !== target && target <= viewer.pagesCount) {
          viewer.currentPageNumber = target;
        }
        landedRef.current = true;
      });
    });

    // The HEAD that sizes the file is itself abortable, so a fast click through
    // three orders does not leave three of them in flight.
    const headAbort = new AbortController();
    let task = null;
    documentArgs(src, headAbort.signal)
      .then((args) => {
        if (cancelled) return;
        task = pdfjs.getDocument(args);
        return task.promise.then((doc) => {
          if (cancelled) return;
          viewer.setDocument(doc);
          linkService.setDocument(doc, null);
          setNumPages(doc.numPages);
        });
      })
      .catch((e) => {
        if (!cancelled && e.name !== "AbortError") setError(e);
      });

    // Re-fitting on resize is ours to do: the viewer holds a scale, not a
    // policy, so "page-width" has to be re-applied when the pane changes width.
    // Not before the opening jump has landed, though -- a scrollbar appearing
    // mid-load is a resize, and a refit scrolls to `_location`, which is still
    // page 1 until a scroll event has been processed.
    const ro = new ResizeObserver(() => {
      if (landedRef.current && fitWidthRef.current && viewerRef.current?.pdfDocument) {
        viewerRef.current.currentScaleValue = "page-width";
      }
    });
    ro.observe(containerRef.current);

    return () => {
      cancelled = true;
      headAbort.abort();
      ro.disconnect();
      viewer.setDocument(null);
      linkService.setDocument(null);
      viewerRef.current = null;
      // Aborts the network requests and kills the worker. Null when the effect
      // is torn down while the sizing HEAD is still out; destroying the task
      // also calls abort() on the transport, which cancels its ranges.
      task?.destroy();
    };
  }, [src, initialPage]);

  const goToPage = (n) => {
    const viewer = viewerRef.current;
    if (!viewer || !numPages || !Number.isFinite(n)) return;
    viewer.currentPageNumber = Math.min(Math.max(Math.trunc(n), 1), numPages);
  };

  const zoomBy = (dir) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const next =
      dir > 0
        ? (ZOOM_STEPS.find((z) => z > scale + 0.001) ?? ZOOM_STEPS.at(-1))
        : (ZOOM_STEPS.filter((z) => z < scale - 0.001).at(-1) ?? ZOOM_STEPS[0]);
    setFitWidth(false);
    viewer.currentScaleValue = String(next);
  };

  const refit = () => {
    setFitWidth(true);
    if (viewerRef.current?.pdfDocument) viewerRef.current.currentScaleValue = "page-width";
  };

  return (
    <div className="pdfviewer">
      <div className="pdfnav">
        <button onClick={() => goToPage(page - 1)} disabled={page <= 1} title="Previous page">
          ‹
        </button>
        <label>
          Page{" "}
          <input
            type="number"
            min="1"
            max={numPages || undefined}
            value={page}
            onChange={(e) => goToPage(Number(e.target.value))}
          />
        </label>
        <span className="muted">of {numPages || "…"}</span>
        <button
          onClick={() => goToPage(page + 1)}
          disabled={!numPages || page >= numPages}
          title="Next page"
        >
          ›
        </button>

        <span className="pdfzoom">
          <button onClick={() => zoomBy(-1)} disabled={scale <= ZOOM_STEPS[0]} title="Zoom out">
            −
          </button>
          {/* Doubles as the fit-width reset, which is where you want to go back
              to nine times out of ten. It reads "Fit" rather than a percentage
              while fitting, because pdf.js's scale is relative to 72 dpi points
              -- a page-width fit is a true 1:1 on screen but reports as 57%,
              which reads like a bug. */}
          <button onClick={refit} aria-pressed={fitWidth} title="Fit the pane's width">
            {fitWidth ? "Fit" : `${Math.round(scale * 100)}%`}
          </button>
          <button
            onClick={() => zoomBy(1)}
            disabled={scale >= ZOOM_STEPS.at(-1)}
            title="Zoom in"
          >
            +
          </button>
        </span>

        {/* A volume-derived order is a handful of pages scattered through
            200-400, and often not consecutive ones -- so the pages that are
            actually this order are jumps, not a range. */}
        {orderPages.length > 0 ? (
          <span className="pdfpages">
            this order:{" "}
            {orderPages.map((p) => (
              <button
                key={p}
                className="pagechip"
                aria-pressed={p === page}
                onClick={() => goToPage(p)}
              >
                {p}
              </button>
            ))}
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="pdfmissing">
          <p>Could not load the scan ({String(error.message ?? error)}).</p>
          <p>
            {/* The scan is a convenience; the document itself is the City's, and
                that copy is always reachable. Offer it first. */}
            {sourceUrl ? (
              <>
                <a href={sourceUrl} target="_blank" rel="noreferrer">
                  read it at the original source ↗
                </a>
                {" · "}
              </>
            ) : null}
            <a href={src} target="_blank" rel="noreferrer">
              try the scan directly ↗
            </a>
          </p>
        </div>
      ) : null}

      {/* PDFViewer measures against an absolutely positioned container, so the
          stage owns the height and the container fills it. Hidden rather than
          unmounted on error: the viewer instance outlives the failure, and its
          container has to still be there when it is torn down. */}
      <div className="pdfstage" hidden={!!error}>
        <div className="pdfscroll" ref={containerRef}>
          <div className="pdfViewer" ref={viewerElRef} />
        </div>
        {!numPages ? <p className="pdfloading">Loading {label ?? "PDF"}…</p> : null}
      </div>
    </div>
  );
}
