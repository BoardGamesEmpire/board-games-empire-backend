import { Action, DatabaseService, type MediaObject, Prisma, ResourceType, Visibility } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import { QuotaExceededException, QuotaService } from '@bge/quota';
import { PaginationQueryDto } from '@bge/shared';
import { type MediaConfig, MediaUrlSigner, StorageService } from '@bge/storage';
import { ObjectNotFoundError, SignatureExpiredError, SignatureInvalidError } from '@boardgamesempire/storage-contract';
import {
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createId } from '@paralleldrive/cuid2';
import { PrismaError } from '@status/codes';
import { imageSize } from 'image-size';
import { Readable } from 'node:stream';
import { formatContentDisposition } from './content-disposition.util';
import { StreamMediaQueryDto, UploadedMediaFile } from './dto';
import { ALLOWED_UPLOAD_MIME_TYPES, INLINE_SAFE_MIME_TYPES } from './media-mime.policy';

@Injectable()
export class MediaObjectService {
  private readonly logger = new Logger(MediaObjectService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly ability: AbilityService,
    private readonly storage: StorageService,
    private readonly signer: MediaUrlSigner,
    private readonly config: ConfigService,
    private readonly quota: QuotaService,
  ) {}

  async upload(file: UploadedMediaFile) {
    if (!ALLOWED_UPLOAD_MIME_TYPES.has(file.mimetype)) {
      throw new UnsupportedMediaTypeException(`Unsupported media type: ${file.mimetype}`);
    }

    const userId = this.ability.getActingUserId();

    // Early guard against the input length: rejects the common over-quota case
    // without writing bytes. Exact for non-transforming drivers.
    await this.assertWithinStorageQuota(userId, BigInt(file.buffer.byteLength));

    const id = createId();
    const key = `users/${userId}/${id}`;
    const stored = await this.storage.put(key, file.buffer, {
      contentType: file.mimetype,
      originalName: file.originalname,
    });

    const dimensions = this.probeImageDimensions(file);

    try {
      // Authoritative gate: the driver computes the true stored size, and that is
      // what usage measures. For a transforming driver it can differ from the
      // input length, so the binding enforcement is here. Cleanup below covers
      // both a quota rejection and a failed insert.
      await this.assertWithinStorageQuota(userId, stored.size);

      return await this.db.mediaObject.create({
        data: {
          id,
          ownerId: userId,
          uploaderId: userId,
          width: dimensions?.width ?? null,
          height: dimensions?.height ?? null,
          visibility: Visibility.Private,
          driverSlug: stored.driverSlug,
          driverKey: key,
          sizeBytes: stored.size,
          mimeType: stored.contentType,
          checksum: stored.checksum,
          etag: stored.etag ?? null,
          originalName: file.originalname ?? null,
        },
      });
    } catch (error) {
      await this.storage
        .delete(key)
        .catch((cleanupError) =>
          this.logger.error(
            `Orphaned bytes at ${key} after failed/over-quota upload; manual cleanup needed`,
            cleanupError,
          ),
        );
      throw error;
    }
  }
  async findById(id: string) {
    const media = await this.db.mediaObject.findUnique({
      where: { id, AND: this.ability.getCurrentResourceConditions(ResourceType.MediaObject, Action.read) },
    });

    if (!media) {
      throw new NotFoundException(`Media object ${id} not found`);
    }

    return media;
  }

  async list(pagination: PaginationQueryDto) {
    return this.db.mediaObject.findMany({
      where: { AND: this.ability.getCurrentResourceConditions(ResourceType.MediaObject, Action.read) },
      skip: pagination.offset,
      take: pagination.limit ?? 10, // ?? not ||: a real limit of 0 isn't silently bumped to 10
    });
  }

  async createSignedUrl(id: string) {
    const media = await this.findById(id); // enforces read access
    const { signedUrlTtlSeconds } = this.config.getOrThrow<MediaConfig>('media');

    return this.storage.signedUrl(media.driverKey, 'get', {
      ttlSeconds: signedUrlTtlSeconds,
      contentType: media.mimeType,
      bindings: { ownerId: media.ownerId },
    });
  }

  async delete(id: string) {
    const media = await this.deleteRowChecked(id);

    await this.storage
      .delete(media.driverKey)
      .catch((error) => this.logger.error(`Deleted row ${id} but failed to remove bytes at ${media.driverKey}`, error));

    return media;
  }

  private async deleteRowChecked(id: string): Promise<MediaObject> {
    try {
      return await this.db.mediaObject.delete({
        where: { id, AND: this.ability.getCurrentResourceConditions(ResourceType.MediaObject, Action.delete) },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === PrismaError.DependentRecordNotFound) {
        throw new NotFoundException(`Media object ${id} not found`);
      }
      throw error;
    }
  }

  /**
   * Verifies a signed-URL request and returns the byte stream. Sessionless — the
   * signature is the authorization. An unknown key returns the SAME 403 as a bad
   * signature so existence isn't leaked to probes; 410 only reaches a caller who
   * presented a cryptographically-valid (i.e. previously-issued) but expired URL.
   */
  async getVerifiedStream(query: StreamMediaQueryDto) {
    const { key, op, exp, sig } = query;

    const media = await this.db.mediaObject.findUnique({
      where: { driverSlug_driverKey: { driverSlug: this.storage.driverSlug, driverKey: key } },
      select: { ownerId: true, mimeType: true, originalName: true }, // hot path: only what we use
    });

    if (!media) {
      throw new ForbiddenException('Invalid signature'); // uniform with a bad sig — no existence oracle
    }

    try {
      await this.signer.verify(
        { key, op, expiresAt: Number(exp), contentType: media.mimeType, bindings: { ownerId: media.ownerId } },
        sig,
      );
    } catch (error) {
      if (error instanceof SignatureExpiredError) {
        throw new GoneException('Signed URL has expired');
      }
      if (error instanceof SignatureInvalidError) {
        throw new ForbiddenException('Invalid signature');
      }
      throw error;
    }

    let body: Readable;
    try {
      ({ body } = await this.storage.get(key));
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        throw new NotFoundException('Media not found');
      }
      throw error;
    }

    const inline = INLINE_SAFE_MIME_TYPES.has(media.mimeType);
    return {
      stream: body,
      contentType: media.mimeType,
      contentDisposition: formatContentDisposition(inline ? 'inline' : 'attachment', media.originalName ?? 'download'),
    };
  }

  async publish(id: string) {
    return this.setVisibility(id, Visibility.Public);
  }

  async unpublish(id: string) {
    return this.setVisibility(id, Visibility.Private);
  }

  private async setVisibility(id: string, visibility: Visibility) {
    try {
      return await this.db.mediaObject.update({
        where: { id, AND: this.ability.getCurrentResourceConditions(ResourceType.MediaObject, Action.update) },
        data: { visibility },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === PrismaError.DependentRecordNotFound) {
        throw new NotFoundException(`Media object ${id} not found`);
      }

      throw error;
    }
  }

  /**
   * Charges the acting user (= owner) for the incoming bytes. Soft-overage caps
   * are honored inside QuotaService (they allow + emit an event); only a hard
   * cap blocks here.
   */
  private async assertWithinStorageQuota(userId: string, amount: bigint): Promise<void> {
    const result = await this.quota.check('storage_bytes', amount, { userId });
    if (!result.allowed) {
      // `allowed` is false only on a hard violation; the binding fields are then set.
      throw new QuotaExceededException('storage_bytes', result.scope!, result.limit!, result.currentUsage!, amount);
    }
  }

  private probeImageDimensions(file: UploadedMediaFile): { width: number; height: number } | null {
    if (!file.mimetype.startsWith('image/')) {
      return null;
    }

    try {
      const { width, height } = imageSize(file.buffer);
      return typeof width === 'number' && typeof height === 'number' ? { width, height } : null;
    } catch (error) {
      this.logger.warn(
        `Failed to probe image dimensions for ${file.originalname}: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }
}
