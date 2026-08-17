import * as pdfjs from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { EventBus, PDFLinkService, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import { useEffect, useRef, useState } from "react";

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

export default function PdfViewer({ src, initialPage = 1, orderPages = [], label }) {
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

    const task = pdfjs.getDocument({ url: src });
    task.promise.then(
      (doc) => {
        if (cancelled) return;
        viewer.setDocument(doc);
        linkService.setDocument(doc, null);
        setNumPages(doc.numPages);
      },
      (e) => !cancelled && setError(e)
    );

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
      ro.disconnect();
      viewer.setDocument(null);
      linkService.setDocument(null);
      viewerRef.current = null;
      // Aborts the network requests and kills the worker.
      task.destroy();
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
          <p>Could not load the PDF ({String(error.message ?? error)}).</p>
          <p>
            The scans are served from a local checkout of the data repo, so this is expected
            anywhere else.{" "}
            <a href={src} target="_blank" rel="noreferrer">
              try it directly ↗
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
