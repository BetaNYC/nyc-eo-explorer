/**
 * The Phase E picture crops, grouped by eo_id.
 *
 * `public/data/pictures.json` is written by scripts/build-data.mjs from the
 * upstream side-car's manifest (vlm-pics/manifest.json), joined to orders on
 * the volume page each crop was clipped from. Small enough to fetch whole, and
 * fetched once per page load rather than per detail view.
 *
 * The tags are HEURISTICS from upstream -- dots.ocr has a single `Picture`
 * category, so a seal, a signature and a scanner artifact all arrive
 * indistinguishable and the side-car separates them on shape, size, position
 * and ink density. `null` means it declined to guess, which is a third answer
 * and not a synonym for "neither".
 */
import { assetUrl, dataUrl } from "../paths.js";

let promise = null;

/** `{ by_eo, count, orphaned, volumes }`; empty shape if the file is absent. */
export function loadPictures() {
  promise ??= fetch(dataUrl("pictures.json"))
    .then((r) => (r.ok ? r.json() : { by_eo: {} }))
    .catch(() => ({ by_eo: {} }));
  return promise;
}

export async function picturesFor(eoId) {
  const { by_eo: byEo } = await loadPictures();
  return byEo?.[eoId] ?? [];
}

/**
 * `by_eo` (eo_id -> [crop]) flattened to one row per crop.
 *
 * Pure, and exported rather than inlined, because two very different consumers
 * need the identical shape: the browser store loads it into DuckDB, and the SQL
 * integration test loads it into a node DuckDB. Two hand-written flatteners
 * would drift and the test would stop testing the thing that ships.
 *
 * A crop on a page shared by two orders is already duplicated in `by_eo` by the
 * builder -- it belongs to both -- so rows are per (eo_id, image), not unique
 * per image.
 */
export function flattenPictures(byEo) {
  const rows = [];
  for (const [eoId, crops] of Object.entries(byEo ?? {})) {
    for (const c of crops ?? []) {
      rows.push({ eo_id: eoId, image: c.image, tag: c.tag ?? null, page: c.page });
    }
  }
  return rows;
}

/**
 * The picture-type filter's options, in display order. `null` is last and is a
 * third answer -- "the heuristic declined to guess" -- not a synonym for
 * "neither a seal nor a signature", so it is offered as its own choice rather
 * than folded into an "other" bucket.
 */
export const PICTURE_TAGS = ["seal", "sig", null];

/** The tag as it travels through the URL hash and SQL, where null cannot ride. */
export const tagKey = (tag) => tag ?? "none";

/**
 * The crops themselves are served from the sibling repo's gitignored
 * `vlm-pics/` by a dev-server mount (see vite.config.js), NOT from public/.
 * They are regenerable pixels, not corpus data, so nothing here assumes they
 * exist -- a crop that has not been rendered locally 404s and the tile falls
 * back to its alt text ("likely city seal, volume page 9").
 */
export const cropUrl = (image) => assetUrl(`pics/${image}`);

export const TAG_LABELS = {
  seal: "likely city seal",
  sig: "likely signature",
};

export const tagLabel = (tag) => TAG_LABELS[tag] ?? "untagged";
