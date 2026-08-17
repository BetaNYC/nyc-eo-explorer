import DOMPurify from "dompurify";
import { marked } from "marked";

/**
 * Render an order's body text as Markdown.
 *
 * The corpus body is Markdown-ish, not plain text: the Phase E VLM OCR emits
 * `# ` / `## ` headings and *emphasis*, and it emits **raw `<table>` HTML** for
 * tabular regions of a scan (library date stamps, schedules). 191 orders carry
 * headings and 98 carry table markup, so rendering it verbatim in a <pre> hides
 * structure the pipeline went to real trouble to recover.
 *
 * `breaks: true`, unlike qa-ui's renderer. qa-ui joins page elements with blank
 * lines, so it does not need it. This corpus does not: across the whole set
 * there are ~146k newlines but only ~5k blank-line pairs, so with `breaks:false`
 * a numbered clause list and a signature block would collapse into one run-on
 * paragraph. In a legal document the line structure is part of the content.
 */
marked.setOptions({ gfm: true, breaks: true });

/**
 * Isolate raw block-level HTML with blank lines before parsing.
 *
 * CommonMark's HTML-block rule says a block-level tag like <table> opens a raw
 * block that runs until the next BLANK line. The OCR output separates lines
 * with single newlines, so everything following a table -- the date, the
 * addressee, the entire body -- gets swallowed into that raw block and emitted
 * verbatim, where its newlines collapse into spaces and the document renders as
 * one run-on paragraph. Padding the table with blank lines closes the raw block
 * at the right place and lets the rest parse as Markdown.
 */
function isolateHtmlBlocks(md) {
  return md.replace(/[ \t]*(<table[\s\S]*?<\/table>)[ \t]*/gi, "\n\n$1\n\n");
}

/**
 * HTML must be allowed through (the tables are raw HTML) and therefore MUST be
 * sanitized. This text is OCR output from scanned documents -- it is not
 * trusted input, and some of it genuinely contains stray angle brackets.
 */
export function renderMarkdown(md) {
  return DOMPurify.sanitize(marked.parse(isolateHtmlBlocks(String(md ?? ""))));
}
