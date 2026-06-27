/** MIME types accepted on upload. SVG and HTML are deliberately excluded — both
 *  are script vectors. Promote to config when per-instance tuning is needed. */
export const ALLOWED_UPLOAD_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
]);

/** Types safe to render inline (non-scripting). Anything allowed but not in this
 *  set is served as an attachment — defense-in-depth if the allowlist grows. */
export const INLINE_SAFE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
]);

/** Hard heap ceiling for a single multipart upload (memory storage buffers the
 *  whole body). Promote to config via a custom interceptor when tunable. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MiB
