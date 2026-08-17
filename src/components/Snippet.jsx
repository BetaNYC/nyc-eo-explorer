/**
 * Render snippet segments. Segments arrive as {text, hit} data, never HTML, so
 * OCR'd text containing a literal "<script>" is displayed, not interpreted.
 */
export default function Snippet({ result }) {
  if (!result) return null;
  const { segments, truncatedStart, truncatedEnd } = result;
  return (
    <p className="snippet">
      {truncatedStart ? "… " : null}
      {segments.map((seg, i) =>
        seg.hit ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>
      )}
      {truncatedEnd ? " …" : null}
    </p>
  );
}
