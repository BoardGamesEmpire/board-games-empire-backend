/**
 * RFC 6266 / 5987 Content-Disposition. Emits an ASCII `filename="..."` fallback
 * plus a UTF-8 `filename*` for correct non-ASCII rendering across browsers.
 */
export function formatContentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `${type}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
