import { Visibility, type MediaObject } from '@bge/database';
import { ApiProperty } from '@nestjs/swagger';

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

/**
 * OpenAPI model for {@link MediaObjectResponse}, so the paginated list declares
 * its rows rather than "an object of unknown shape".
 *
 * `implements MediaObjectResponse` is the load-bearing part: without it a field
 * added to the served shape would leave this class quietly behind, and the
 * document would keep describing a response the endpoint no longer returns. The
 * pattern is the one #354 established for the plugin inventory rows.
 *
 * `sizeBytes` is a string on the wire: the column is a BigInt, which JSON has
 * no representation for, and the mapper stringifies it. Documenting it as a
 * number would hand a generated client a type its parse would silently narrow.
 */
export class MediaObjectResponseDto implements MediaObjectResponse {
  @ApiProperty({ description: 'Media object identifier' })
  id!: string;

  @ApiProperty({ description: 'Owner of the stored bytes — re-attributed when a contribution is approved' })
  ownerId!: string;

  @ApiProperty({ description: 'Who uploaded it; permanent credit, never re-attributed' })
  uploaderId!: string;

  @ApiProperty({ enum: Visibility, enumName: 'Visibility' })
  visibility!: Visibility;

  @ApiProperty({ example: 'image/png' })
  mimeType!: string;

  @ApiProperty({ description: 'Size in bytes, as a string — the column is a BigInt', example: '20480' })
  sizeBytes!: string;

  @ApiProperty({ description: 'Content checksum' })
  checksum!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Storage ETag, when the driver supplies one' })
  etag!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Filename as uploaded' })
  originalName!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;

  @ApiProperty({ type: Number, nullable: true, description: 'Pixel width, for images' })
  width!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Pixel height, for images' })
  height!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Page count, for documents' })
  pageCount!: number | null;
}
