/**
 * The subset of a Multer (memory-storage) file this lib consumes — avoids a hard
 * dependency on @types/multer for a single param type.
 */
export interface UploadedMediaFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}
