import type { MediaObject } from '@bge/database';
import { Action, ContributionOrigin, DatabaseService, Prisma, ResourceType, Visibility } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import { QuotaExceededException, QuotaService } from '@bge/quota';
import { PaginationQueryDto } from '@bge/shared';
import type { MediaConfig } from '@bge/storage';
import { MediaUrlSigner, StorageService } from '@bge/storage';
import type { StorageLocator, StoredObject } from '@boardgamesempire/storage-contract';
import {
  DriverNotRegisteredError,
  ObjectNotFoundError,
  SignatureExpiredError,
  SignatureInvalidError,
} from '@boardgamesempire/storage-contract';
import {
  BadRequestException,
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
import { ContributeMediaDto, StreamMediaQueryDto, UploadedMediaFile } from './dto';
import { MediaLinkService } from './link/link.service';
import { MediaContributionService } from './media-contribution.service';
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
    private readonly contributions: MediaContributionService,
    private readonly mediaLink: MediaLinkService,
  ) {}

  async upload(file: UploadedMediaFile) {
    if (!ALLOWED_UPLOAD_MIME_TYPES.has(file.mimetype)) {
      throw new UnsupportedMediaTypeException(`Unsupported media type: ${file.mimetype}`);
    }

    const userId = this.ability.getActingUserId();
    await this.assertWithinStorageQuota(userId, BigInt(file.buffer.byteLength)); // early, non-atomic guard

    const prepared = await this.writeBytes(file, userId);
    return this.withByteCompensation({ driverSlug: prepared.stored.driverSlug, driverKey: prepared.key }, () =>
      this.db.$transaction((tx) =>
        this.storeOwnedObjectWithin(tx, { ...prepared, userId, originalName: file.originalname ?? null }),
      ),
    );
  }

  /**
   * Upload new bytes AND contribute them in one operation (ContributionOrigin.DirectUpload —
   * media the user uploads solely to give away; swept on reject after the reclaim window).
   * The object create, quota consume, and contribution all commit in a single transaction;
   * the bytes are compensated on any rollback.
   */
  async uploadAndContribute(file: UploadedMediaFile, dto: ContributeMediaDto) {
    if (!ALLOWED_UPLOAD_MIME_TYPES.has(file.mimetype)) {
      throw new UnsupportedMediaTypeException(`Unsupported media type: ${file.mimetype}`);
    }
    // Fail fast before writing bytes: a type that can't link to the subject can never be approved.
    if (!this.mediaLink.canLink(file.mimetype, dto.subjectType)) {
      throw new BadRequestException(`This media type can't be contributed to a ${dto.subjectType}`);
    }

    const userId = this.ability.getActingUserId();
    await this.assertWithinStorageQuota(userId, BigInt(file.buffer.byteLength));

    const prepared = await this.writeBytes(file, userId);
    return this.withByteCompensation({ driverSlug: prepared.stored.driverSlug, driverKey: prepared.key }, () =>
      this.db.$transaction(async (tx) => {
        const created = await this.storeOwnedObjectWithin(tx, {
          ...prepared,
          userId,
          originalName: file.originalname ?? null,
        });
        const contribution = await this.contributions.createContributionWithin(
          tx,
          created.id,
          dto,
          ContributionOrigin.DirectUpload,
          userId,
        );
        // Auto-approval flips ownerId + visibility in this same tx, so the create()
        // result is stale — return the post-flip row.
        const media = await tx.mediaObject.findUniqueOrThrow({ where: { id: created.id } });
        return { media, contribution };
      }),
    );
  }

  /** Pre-transaction: allocate id/key, write bytes, probe dimensions. Caller compensates on later failure. */
  private async writeBytes(
    file: UploadedMediaFile,
    userId: string,
  ): Promise<{ id: string; key: string; stored: StoredObject; dimensions: { width: number; height: number } | null }> {
    const id = createId();
    const key = `users/${userId}/${id}`;
    const stored = await this.storage.put(key, file.buffer, {
      contentType: file.mimetype,
      originalName: file.originalname,
    });
    return { id, key, stored, dimensions: this.probeImageDimensions(file) };
  }

  /** In-transaction: atomically consume storage quota for the true stored size and create the owned (Private) row. */
  private async storeOwnedObjectWithin(
    tx: Prisma.TransactionClient,
    params: {
      id: string;
      key: string;
      userId: string;
      stored: StoredObject;
      dimensions: { width: number; height: number } | null;
      originalName: string | null;
    },
  ): Promise<MediaObject> {
    const { id, key, userId, stored, dimensions, originalName } = params;

    const decision = await this.quota.consume('storage_bytes', stored.size, { userId }, tx);
    if (!decision.allowed) {
      throw new QuotaExceededException(
        'storage_bytes',
        decision.scope!,
        decision.limit!,
        decision.currentUsage!,
        stored.size,
      );
    }

    return tx.mediaObject.create({
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
        originalName: originalName ?? null,
      },
    });
  }

  /**
   * Runs `fn`; if it throws, compensates the orphaned bytes (storage isn't transactional) and rethrows.
   */
  private async withByteCompensation<T>(locator: StorageLocator, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      await this.storage
        .delete(locator)
        .catch((cleanupError) =>
          this.logger.error(
            `Orphaned bytes at ${locator.driverSlug}/${locator.driverKey} after failed/over-quota upload; manual cleanup needed`,
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

    return this.storage.signedUrl({ driverSlug: media.driverSlug, driverKey: media.driverKey }, 'get', {
      ttlSeconds: signedUrlTtlSeconds,
      contentType: media.mimeType,
      bindings: { ownerId: media.ownerId },
    });
  }

  async delete(id: string) {
    const media = await this.deleteRowChecked(id);

    await this.storage
      .delete({ driverSlug: media.driverSlug, driverKey: media.driverKey })
      .catch((error) =>
        this.logger.error(
          `Deleted row ${id} but failed to remove bytes at ${media.driverSlug}/${media.driverKey}`,
          error,
        ),
      );

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
    const { slug, key, op, exp, sig } = query;

    const media = await this.db.mediaObject.findUnique({
      where: { driverSlug_driverKey: { driverSlug: slug, driverKey: key } },
      select: { ownerId: true, mimeType: true, originalName: true }, // hot path: only what we use
    });

    if (!media) {
      throw new ForbiddenException('Invalid signature'); // uniform with a bad sig — no existence oracle
    }

    try {
      await this.signer.verify(
        { slug, key, op, expiresAt: Number(exp), contentType: media.mimeType, bindings: { ownerId: media.ownerId } },
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
      ({ body } = await this.storage.get({ driverSlug: slug, driverKey: key }));
    } catch (error) {
      // The slug here is signature-bound, so this only runs for a valid URL. An
      // object whose recorded driver is no longer configured (#100) is unservable —
      // log it loud, but return the same 404 as missing bytes (no internals leaked).
      if (error instanceof DriverNotRegisteredError) {
        this.logger.error(`Media ${slug}/${key} references unregistered driver '${error.slug}'`, error);
        throw new NotFoundException('Media not found');
      }
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
