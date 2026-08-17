// @vitest-environment jsdom
// DOMPurify needs a DOM; the rest of the suite runs in node.
import { describe, expect, it } from "vitest";

import { renderMarkdown } from "../src/markdown.js";

describe("renderMarkdown", () => {
  it("renders headings the OCR pipeline emits", () => {
    expect(renderMarkdown("# CITY OF NEW YORK")).toContain("<h1>CITY OF NEW YORK</h1>");
    expect(renderMarkdown("## Section")).toContain("<h2>Section</h2>");
  });

  it("keeps single newlines as line breaks", () => {
    // ~146k newlines vs ~5k blank-line pairs in this corpus. Without breaks:true
    // a signature block collapses into one run-on line.
    const html = renderMarkdown("s/ John V. Lindsay\nJOHN V. LINDSAY\nMAYOR");
    expect(html).toContain("<br>");
    expect(html).toContain("JOHN V. LINDSAY");
  });

  it("preserves the raw <table> HTML the VLM emits", () => {
    const md = "<table><tr><td>MUNICIPAL REFERENCE LIBRARY</td></tr></table>";
    const html = renderMarkdown(md);
    expect(html).toContain("<table>");
    expect(html).toContain("MUNICIPAL REFERENCE LIBRARY");
  });

  it("does not let a table swallow the rest of the document", () => {
    // CommonMark's HTML-block rule runs a raw <table> block until a BLANK line.
    // The OCR output uses single newlines, so without isolating the table
    // everything after it is emitted raw and collapses into one run-on line.
    const md = [
      "# CITY OF NEW YORK",
      "<table><tr><td>STAMP</td></tr></table>",
      "January 10, 1946",
      "MEMORANDUM NO. 2",
      "TO: HEADS OF ALL AGENCIES",
    ].join("\n");
    const html = renderMarkdown(md);
    expect(html).toContain("<table>");
    // The trailing lines must parse as Markdown, so they get real breaks...
    expect(html).toMatch(/January 10, 1946\s*<br>/);
    // ...and must not still be sitting inside the raw HTML block.
    expect(html).not.toMatch(/<\/table>\s*January/);
  });

  it("keeps line breaks in text that follows a table", () => {
    const html = renderMarkdown("<table><tr><td>x</td></tr></table>\na\nb");
    const afterTable = html.slice(html.indexOf("</table>"));
    expect(afterTable).toContain("<br>");
  });

  it("strips script tags", () => {
    // This is OCR output from scanned documents -- untrusted by construction.
    const html = renderMarkdown('Order text <script>alert("xss")</script> continues');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(");
    expect(html).toContain("Order text");
  });

  it("strips inline event handlers and javascript: URLs", () => {
    expect(renderMarkdown('<img src=x onerror="alert(1)">')).not.toContain("onerror");
    expect(renderMarkdown('<a href="javascript:alert(1)">x</a>')).not.toContain("javascript:");
  });

  it("strips iframes and object embeds", () => {
    expect(renderMarkdown('<iframe src="https://evil.test"></iframe>')).not.toContain(
      "<iframe"
    );
    expect(renderMarkdown("<object data=x></object>")).not.toContain("<object");
  });

  it("renders emphasis and lists", () => {
    expect(renderMarkdown("*[Picture]*")).toContain("<em>");
    expect(renderMarkdown("- one\n- two")).toContain("<li>");
  });

  it("handles empty and null input without throwing", () => {
    expect(renderMarkdown("")).toBe("");
    expect(() => renderMarkdown(null)).not.toThrow();
    expect(() => renderMarkdown(undefined)).not.toThrow();
  });

  it("does not mangle the section symbol or ordinary punctuation", () => {
    const html = renderMarkdown("§5. Executive Order No. 38 dated May 16, 1957");
    expect(html).toContain("§5.");
    expect(html).toContain("No. 38");
  });
});
