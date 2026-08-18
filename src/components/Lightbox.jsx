import { useEffect, useRef } from "react";

import { longLabel } from "../data/labels.js";
import { cropUrl, onCropError, tagLabel } from "../data/pictures.js";

const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString(undefined, { timeZone: "UTC" }) : null;

/**
 * A crop at full size, over the grid.
 *
 * The grid boxes every tile to 120px tall so a page of them is scannable, which
 * is the right default and the wrong size for the thing people actually come
 * here to read: a mayoral signature is a wide, thin ribbon and is illegible at
 * thumbnail scale. So the tile is a button and this is what it opens.
 *
 * `items` is the whole rendered page, not just the clicked row, so the arrow
 * keys can step through it -- comparing consecutive signatures is the point.
 */
export default function Lightbox({ items, index, onIndex, onClose, onOpen }) {
  const closeRef = useRef(null);
  const item = items[index];

  // Keyboard is bound on document rather than on the dialog: the overlay takes
  // focus, but a click on the backdrop moves it to <body> and a listener on the
  // dialog would then stop hearing Escape.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") onIndex(Math.min(index + 1, items.length - 1));
      else if (e.key === "ArrowLeft") onIndex(Math.max(index - 1, 0));
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, items.length, onClose, onIndex]);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  if (!item) return null;

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`${tagLabel(item.tag)} from ${longLabel(item)}`}
      // Only a click on the backdrop itself closes; one that started inside the
      // figure and drifted out (selecting the caption) must not.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="lbinner">
        <button className="lbclose" onClick={onClose} ref={closeRef} aria-label="Close">
          ✕
        </button>

        <figure className="lbfig">
          <img
            src={cropUrl(item.image)}
            alt={`${tagLabel(item.tag)}, volume page ${item.page}`}
            onError={onCropError}
          />
          <figcaption className="lbcap">
            <span className={`badge pic-${item.tag ?? "none"}`}>{tagLabel(item.tag)}</span>
            <a
              href={`#eo=${item.eo_id}`}
              onClick={(e) => {
                e.preventDefault();
                onOpen(item.eo_id);
              }}
            >
              {longLabel(item)}
            </a>
            <span className="muted">
              {item.mayor} · {fmtDate(item.date_signed) ?? `${item.year} (date unknown)`} ·
              volume page {item.page}
            </span>
            {item.title ? <span className="lbtitle">{item.title}</span> : null}
          </figcaption>
        </figure>

        <div className="lbnav">
          <button onClick={() => onIndex(index - 1)} disabled={index === 0}>
            ‹ Prev
          </button>
          <span className="muted">
            {index + 1} of {items.length}
          </span>
          <button onClick={() => onIndex(index + 1)} disabled={index === items.length - 1}>
            Next ›
          </button>
        </div>
      </div>
    </div>
  );
}
