import type { MediaObject, Visibility } from '@bge/database';

/** Public shape of a MediaObject. Excludes the internal storage location
 *  (driverKey/driverSlug) and stringifies the BigInt size for JSON. */
export interface MediaObjectResponse {
  id: string;
  ownerId: string;
  uploaderId: string;
  visibility: Visibility;
  mimeType: string;
  sizeBytes: string;
  checksum: string;
  etag: string | null;
  originalName: string | null;
  createdAt: string;
  updatedAt: string;
  width: number | null;
  height: number | null;
  pageCount: number | null;
}

export function toMediaObjectResponse(media: MediaObject): MediaObjectResponse {
  return {
    id: media.id,
    ownerId: media.ownerId,
    uploaderId: media.uploaderId,
    visibility: media.visibility,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes.toString(),
    checksum: media.checksum,
    etag: media.etag,
    originalName: media.originalName,
    createdAt: media.createdAt.toISOString(),
    updatedAt: media.updatedAt.toISOString(),
    width: media.width,
    height: media.height,
    pageCount: media.pageCount,
  };
}
