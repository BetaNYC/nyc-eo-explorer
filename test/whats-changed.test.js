// @vitest-environment jsdom
/**
 * The "What's changed" page and the footer link to it.
 *
 * The page is public/whats-changed.html, built from WHATS-CHANGED.md by
 * scripts/whats_changed.py (a copy of BetaNYC's shared renderer; never edit it
 * here). These tests catch the three ways it breaks: the file stops parsing,
 * the built page falls behind the file, or the footer stops linking to it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import SiteFooter from "../src/components/SiteFooter.jsx";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = join(ROOT, "public", "whats-changed.html");

const python = (() => {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("What's changed", () => {
  it.skipIf(!python)("WHATS-CHANGED.md passes the shared check", () => {
    execFileSync("python3", ["scripts/whats_changed.py", "check", "WHATS-CHANGED.md"], {
      cwd: ROOT,
      stdio: "pipe",
    });
  });

  it.skipIf(!python)("public/whats-changed.html is rebuilt from the current file", () => {
    // Same arguments as the CI step in .github/workflows/whats-changed.yml.
    execFileSync(
      "python3",
      [
        "scripts/whats_changed.py",
        "render",
        "WHATS-CHANGED.md",
        "--format",
        "page",
        "--out",
        "public/whats-changed.html",
        "--site-name",
        "NYC Executive Orders",
        "--home-url",
        "./",
        "--repo-url",
        "https://github.com/BetaNYC/nyc-eo-explorer",
        "--check",
      ],
      { cwd: ROOT, stdio: "pipe" }
    );
  });

  // Counts come from the parsed file, not from constants, so an Update line or
  // an `Unreleased:` entry (which has no date yet) does not break the test.
  it.skipIf(!python)("the page has the accessible structure the standard asks for", () => {
    const parsed = JSON.parse(
      execFileSync("python3", ["scripts/whats_changed.py", "json", "WHATS-CHANGED.md"], {
        cwd: ROOT,
        encoding: "utf8",
      })
    );
    const entries = parsed.entries.filter((e) => e.valid);
    const doc = new DOMParser().parseFromString(readFileSync(PAGE, "utf8"), "text/html");
    const h1s = doc.querySelectorAll("h1");
    expect(h1s.length).toBe(1);
    expect(h1s[0].textContent).toBe("What's changed");
    for (const sel of ["header", "nav", "main", "footer", 'a[href="#main"]'])
      expect(doc.querySelector(sel), sel).not.toBeNull();
    expect(doc.querySelectorAll("main article").length).toBe(entries.length);
    for (const e of entries) {
      const article = doc.getElementById(e.anchor);
      expect(article, e.anchor).not.toBeNull();
      if (!e.unreleased)
        expect(article.querySelector(`time[datetime="${e.date}"]`), e.anchor).not.toBeNull();
    }
    expect(doc.querySelector("fieldset legend")?.textContent).toBe("Show changes to");
    expect(doc.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
    // The "Corrections only" box is there only when the file has a correction.
    const hasCorrection = entries.some((e) => e.tags.includes("Correction"));
    expect(doc.querySelector("fieldset").textContent.includes("Corrections only")).toBe(
      hasCorrection
    );
    // The link home must stay relative, so it works under /nyc-eo-explorer/.
    expect(doc.querySelector('nav a[href="./"]')).not.toBeNull();
  });

  it("the footer links to the page under the site's base path", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(SiteFooter));
    const link = [...host.querySelectorAll("footer a")].find(
      (a) => a.textContent === "What's changed"
    );
    expect(link?.getAttribute("href")).toBe(`${import.meta.env.BASE_URL}whats-changed.html`);
  });
});
