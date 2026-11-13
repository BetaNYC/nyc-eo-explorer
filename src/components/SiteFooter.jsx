/**
 * The footer on every view. This is a single-page app, so one footer in App is
 * on every page of it. The What's changed page is a plain file in public/,
 * built from WHATS-CHANGED.md by scripts/whats_changed.py; BASE_URL keeps the
 * link right under the GitHub Pages subpath (/nyc-eo-explorer/) and at "/" in dev.
 */
export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <a href={`${import.meta.env.BASE_URL}whats-changed.html`}>{"What's changed"}</a>
      <a href="https://github.com/BetaNYC/nyc-eo-explorer">Source on GitHub</a>
      <a href="https://beta.nyc/">BetaNYC</a>
    </footer>
  );
}
