# What's changed

This page lists the changes to the NYC Executive Orders explorer that a reader would notice: new tabs and tools, fixes, and corrections when we published something wrong. Newest first. The orders themselves come from BetaNYC's executive orders corpus, which is still being checked and filled in, so routine updates to the orders are not listed here.

- **History begins:** 2026-08-18, the day the explorer went live. Corrections made before this date may be missing.
- **Data refresh:** whenever the site is rebuilt, from the latest copy of the corpus. There is no fixed schedule.

To report a bug in this site or ask for a new feature, open an issue at https://github.com/BetaNYC/nyc-eo-explorer/issues.

## 2026-11-12: A page that lists what has changed

- **Tags:** Site
- **What changed:** This page is new. It lists the changes to the explorer that a reader would notice, newest first, and every page of the explorer links to it at the bottom.
- **More detail:** [The same list on GitHub](WHATS-CHANGED.md)

## 2026-09-09: Scans that showed a blank page now show

- **Tags:** Site
- **What changed:** When you opened an order, some scanned source pages had shown up blank in the viewer beside the text since launch. The viewer now loads the image decoders those scans need, so the page images show.
- **More detail:** [The fix](https://github.com/BetaNYC/nyc-eo-explorer/commit/1cf14c609bbdffa01ae6efaa2ee8d14e5739c37d)

## 2026-09-08: New Agencies tab shows which orders name each City agency

- **Tags:** Site, Data
- **What changed:** A new Agencies tab lists every City agency or office the orders name, with a page for each one: the orders that name it, year by year, and the agencies most often named alongside it. Names that match BetaNYC's list of current agencies are marked Confirmed. Other names, including bodies that no longer exist, are marked Proposed, because nobody has reviewed them yet.
- **Who it affects:** Anyone looking up an agency's history in the orders. The list shows every name it found, including names seen in only one order.
- **More detail:** [How the Agencies tab works](README.md#agencies) · [The agency data, added to the corpus](https://github.com/BetaNYC/nyc-executive-orders/pull/18) · [The tab](https://github.com/BetaNYC/nyc-eo-explorer/commit/2bba1f5) · [Show every name](https://github.com/BetaNYC/nyc-eo-explorer/commit/45b3273)

## 2026-09-01: Search results come in pages, and links keep your filters

- **Tags:** Site
- **What changed:** Search results now come in pages you can step through. Clicking a link inside the explorer no longer clears your filters, and you can open a link in a new tab.
- **More detail:** [Pages of results](https://github.com/BetaNYC/nyc-eo-explorer/commit/8f991b6) · [Links](https://github.com/BetaNYC/nyc-eo-explorer/commit/5ca422c)

## 2026-08-31: The Back button returns you to where you were

- **Tags:** Site
- **What changed:** The browser's Back button now takes you to the page you were on before, with your filters still set.
- **More detail:** [The fix](https://github.com/BetaNYC/nyc-eo-explorer/commit/60f72ee)

## 2026-08-18: The explorer went live

- **Tags:** Site, Data
- **What changed:** A free website to search and browse New York City mayoral executive orders, with no account needed. Search the full text of every order in BetaNYC's corpus, filter by mayor and year, and read each order beside a scan of the original. A Pictures tab shows the seals and signatures clipped from the oldest scans.
- **More detail:** [About the explorer](README.md) · [The first version](https://github.com/BetaNYC/nyc-eo-explorer/commit/e736363)
