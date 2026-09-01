import { appHandlesClick } from "../state/hash.js";

/**
 * An in-app link that is also a real link.
 *
 * Every navigation in this app is a state change plus one hash write, and the
 * hash it writes is the WHOLE state -- the tab, the filters, the agencies
 * chosen on a graph. An `<a href="#eo=...">` that is left to the browser writes
 * a hash that is none of those things: it drops everything but the one key in
 * the href, adds a history entry the app did not make, and fires hashchange,
 * which the app obeys. The page then loads with the filters gone and the back
 * button pointing at an entry nobody asked for.
 *
 * That race is why the href and the handler have to be kept in step here rather
 * than at each of the eight call sites, where five of them had drifted.
 *
 * The href stays real, so the status bar shows a destination, and copy-link,
 * middle-click and command-click all still work: those are the browser's clicks
 * to handle, and a new tab starts from the hash alone anyway.
 */
export default function HashLink({ href, onOpen, children, ...rest }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        if (!appHandlesClick(e)) return;
        e.preventDefault();
        onOpen();
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
