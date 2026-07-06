import {
  Action,
  DatabaseService,
  isPrismaDependentRecordNotFoundError,
  Prisma,
  ResourceType,
  Visibility,
} from '@bge/database';
import { AbilityService } from '@bge/permissions';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CreateGameCollectionDto,
  ListGameCollectionsQueryDto,
  ListUserGameCollectionsQueryDto,
  RemoveGameCollectionQueryDto,
  UpdateGameCollectionDto,
} from './dto';

/** Keeps only the keys the caller actually sent (undefined = "not provided"). */
const pickDefined = <T extends object>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as Partial<T>;

@Injectable()
export class GameCollectionService {
  private readonly logger = new Logger(GameCollectionService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
  ) {}

  /** Joined summary needed to render a collection list/detail without extra fetches. */
  private readonly collectionInclude = {
    platformGame: {
      select: {
        id: true,
        image: true,
        thumbnail: true,
        platform: { select: { id: true, name: true, slug: true } },
        game: { select: { id: true, title: true, subtitle: true, image: true, thumbnail: true } },
      },
    },
    release: { select: { id: true, editionName: true, releaseYear: true } },
  } satisfies Prisma.GameCollectionInclude;

  /**
   * The acting user's own collection. Tombstoned (previously owned) entries are
   * excluded by default; `includeDeleted` adds them (delta sync), `deletedOnly`
   * is the resurrection view.
   */
  async listOwn({
    offset,
    limit,
    includeDeleted,
    deletedOnly,
    medium,
    favorite,
    updatedSince,
  }: ListGameCollectionsQueryDto) {
    const userId = this.abilityService.getActingUserId();

    return this.db.gameCollection.findMany({
      where: {
        userId,
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.GameCollection, Action.read),
        ...(deletedOnly ? { deletedAt: { not: null } } : includeDeleted ? {} : { deletedAt: null }),
        ...(medium ? { medium } : {}),
        ...(favorite !== undefined ? { favorite } : {}),
        ...(updatedSince ? { updatedAt: { gte: updatedSince } } : {}),
      },
      include: this.collectionInclude,
      orderBy: { updatedAt: 'desc' },
      skip: offset,
      take: limit || 20,
    });
  }

  /**
   * Another user's collection, filtered to what the acting user may see. For an
   * authenticated viewer the CASL read conditions grant own/household/friends/
   * public scopes; an anonymous viewer (primed with no abilities) sees Public
   * entries only. Tombstones are never exposed through this view.
   */
  async listForUser(targetUserId: string, { offset, limit, medium }: ListUserGameCollectionsQueryDto) {
    // Anonymous actors have no ability surface yet (`resolveAbilitiesForActor`
    // throws for 'anonymous'; the middleware primes `[]` — see issue #68), so
    // the Public filter is applied explicitly here. When an anonymous ability
    // set lands, this branch collapses into the CASL path below.
    const isAnonymous = this.abilityService.getCurrentAbilities().length === 0;

    return this.db.gameCollection.findMany({
      where: {
        userId: targetUserId,
        deletedAt: null,
        ...(medium ? { medium } : {}),
        ...(isAnonymous
          ? { visibility: Visibility.Public }
          : { AND: this.abilityService.getCurrentResourceConditions(ResourceType.GameCollection, Action.read) }),
      },
      include: this.collectionInclude,
      orderBy: { updatedAt: 'desc' },
      skip: offset,
      take: limit || 20,
    });
  }

  /** A single entry the acting user may read (owner sees own tombstones). */
  async getById(id: string) {
    const collection = await this.db.gameCollection.findUnique({
      where: {
        id,
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.GameCollection, Action.read),
      },
      include: this.collectionInclude,
    });

    if (!collection) {
      throw new NotFoundException(`Collection entry with ID ${id} not found`);
    }

    return collection;
  }

  /**
   * Add a game to the acting user's collection. Idempotent upsert on the
   * `(user, platformGame, medium)` identity: re-adding an active entry updates
   * the provided fields, and re-adding a removed entry resurrects it — the
   * tombstone is cleared while server-managed play history (`playCount`,
   * `lastPlayed`) and any unspecified fields survive the remove→re-add cycle.
   */
  async addToCollection(dto: CreateGameCollectionDto) {
    const userId = this.abilityService.getActingUserId();
    const { platformGameId, medium, releaseId, ...attributes } = dto;

    const platformGame = await this.db.platformGame.findUnique({
      where: { id: platformGameId },
      select: { id: true },
    });
    if (!platformGame) {
      throw new NotFoundException(`Platform game with ID ${platformGameId} not found`);
    }

    if (releaseId) {
      await this.assertReleaseBelongsTo(releaseId, platformGameId);
    }

    const provided = pickDefined({ ...attributes, releaseId });
    const lastUpdated = new Date();

    try {
      return await this.db.gameCollection.upsert({
        where: { userId_platformGameId_medium: { userId, platformGameId, medium } },
        create: { userId, platformGameId, medium, ...provided, lastUpdated },
        update: { ...provided, deletedAt: null, deleteReason: null, lastUpdated },
        include: this.collectionInclude,
      });
    } catch (error) {
      this.logger.error(`Error adding platform game ${platformGameId} to collection for user ${userId}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new NotFoundException(`Platform game with ID ${platformGameId} not found`);
      }

      throw error;
    }
  }

  /**
   * Patch the mutable fields of an entry. Standard REST semantics: omitted
   * fields are preserved, explicit `null` clears nullable fields. Identity
   * (`platformGameId`/`medium`) and play history (`playCount`/`lastPlayed`)
   * are not writable here.
   */
  async update(id: string, dto: UpdateGameCollectionDto) {
    const data = pickDefined(dto);
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('At least one field must be provided for update');
    }

    // Only a release change needs a pre-read (the row's platform game); every
    // other patch goes straight to the scoped update.
    if (data.releaseId) {
      const existing = await this.db.gameCollection.findUnique({
        where: {
          id,
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.GameCollection, Action.update),
        },
        select: { platformGameId: true },
      });

      if (!existing) {
        throw new NotFoundException(`Collection entry with ID ${id} not found`);
      }

      await this.assertReleaseBelongsTo(data.releaseId, existing.platformGameId);
    }

    try {
      return await this.db.gameCollection.update({
        where: {
          id,
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.GameCollection, Action.update),
        },
        data: { ...data, lastUpdated: new Date() },
        include: this.collectionInclude,
      });
    } catch (error) {
      throw this.mapMissingToNotFound(error, id);
    }
  }

  /**
   * Remove a game from the collection — "I no longer own this", not "never
   * played". A tombstone, never a hard delete: play history must survive a
   * remove→re-add cycle, and child rows (locations, event game lists, loans)
   * would otherwise cascade away.
   */
  async remove(id: string, { reason }: RemoveGameCollectionQueryDto) {
    const now = new Date();

    // Single scoped write: `deletedAt: null` in the filter makes a repeat
    // delete (or a foreign/missing row) miss and surface as 404.
    try {
      return await this.db.gameCollection.update({
        where: {
          id,
          deletedAt: null,
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.GameCollection, Action.delete),
        },
        data: { deletedAt: now, deleteReason: reason ?? null, lastUpdated: now },
        include: this.collectionInclude,
      });
    } catch (error) {
      throw this.mapMissingToNotFound(error, id);
    }
  }

  /**
   * The scoped `where` matched no row: missing, already tombstoned (remove), or
   * outside the actor's CASL scope. All collapse to 404 so foreign rows are
   * indistinguishable from absent ones (mirrors FriendshipService).
   */
  private mapMissingToNotFound(error: unknown, id: string) {
    if (isPrismaDependentRecordNotFoundError(error)) {
      return new NotFoundException(`Collection entry with ID ${id} not found`);
    }

    this.logger.error(`Error mutating collection entry with id ${id}`, error);
    return error instanceof Error ? error : new Error(String(error));
  }

  private async assertReleaseBelongsTo(releaseId: string, platformGameId: string) {
    const release = await this.db.gameRelease.findUnique({
      where: { id: releaseId },
      select: { platformGameId: true },
    });

    if (!release) {
      throw new NotFoundException(`Release with ID ${releaseId} not found`);
    }

    if (release.platformGameId !== platformGameId) {
      throw new BadRequestException(`Release ${releaseId} does not belong to platform game ${platformGameId}`);
    }
  }
}
