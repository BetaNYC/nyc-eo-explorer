#!/usr/bin/env node
/**
 * Build the Parquet artifacts if they are missing or stale, then get out of the way.
 *
 * Wired to `predev` and `prebuild` so a fresh clone reaches a running app with
 * `npm install && npm run dev` and nothing else. Stale = any corpus JSON in the
 * sibling data repo is newer than the manifest we last generated.
 */
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const OUT_DIR = join(REPO_ROOT, "public", "data");
const MANIFEST = join(OUT_DIR, "manifest.json");
const CORPUS_DIR = resolve(
  process.env.EO_CORPUS_DIR || join(REPO_ROOT, "..", "nyc-executive-orders", "corpus")
);
const PICS_DIR = resolve(
  process.env.EO_PICS_DIR || join(REPO_ROOT, "..", "nyc-executive-orders", "vlm-pics")
);

const mtime = async (p) => (existsSync(p) ? (await stat(p)).mtimeMs : 0);

async function needsRebuild() {
  if (!existsSync(MANIFEST)) return "no data built yet";

  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  for (const name of Object.keys(manifest.files ?? {})) {
    if (!existsSync(join(OUT_DIR, name))) return `${name} is missing`;
  }

  const builtAt = await mtime(MANIFEST);
  for (const name of ["eo.json", "eo_pre1974.json", "supersession.json"]) {
    const p = join(CORPUS_DIR, name);
    if ((await mtime(p)) > builtAt) return `${name} changed upstream`;
  }
  // The picture side-car runs per volume and merge-updates one manifest, so
  // this moves every time another volume is clipped.
  if ((await mtime(join(PICS_DIR, "manifest.json"))) > builtAt) return "picture crops changed";
  // Phase E output appearing for the first time is also a reason to rebuild.
  if (existsSync(join(CORPUS_DIR, "eo_pre1974.json")) && !manifest.includes_pre1974) {
    return "pre-1974 corpus appeared upstream";
  }
  return null;
}

const reason = await needsRebuild();
if (!reason) {
  console.log("data/ is up to date");
  process.exit(0);
}

console.log(`rebuilding data (${reason})`);
const { default: spawn } = await import("node:child_process").then((m) => ({
  default: m.spawnSync,
}));
const res = spawn(process.execPath, [join(HERE, "build-data.mjs")], { stdio: "inherit" });
process.exit(res.status ?? 1);
