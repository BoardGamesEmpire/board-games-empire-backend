/**
 * The subset of a Multer (memory-storage) file this lib consumes. Kept as a
 * narrow interface rather than `Express.Multer.File` (available since we added
 * `@types/multer`): it documents the four fields we actually read and lets
 * callers and tests supply just those — the full Multer type requires ten,
 * several of them storage-engine-specific (`stream`/`path` are disk-only,
 * `buffer` memory-only).
 */
export interface UploadedMediaFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}
