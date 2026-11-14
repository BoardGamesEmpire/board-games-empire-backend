import {
  Action,
  constraintIdentity,
  DatabaseService,
  identifiesConstraint,
  isPrismaDependentRecordNotFoundError,
  isPrismaForeignKeyConstraintError,
  isPrismaUniqueConstraintError,
  ListKind,
  Prisma,
  ResourceType,
  type WishlistPriority,
} from '@bge/database';
import type { CodedHttpException } from '@bge/i18n';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import { PaginatedRows, PaginationQueryDto, pickDefined } from '@bge/shared';
import { Injectable, Logger } from '@nestjs/common';
import { CreateListEntryDto, ListEntryDto, ReorderListEntriesDto, UpdateListEntryDto } from './dto';
import { LIST_ENTRY_SELECT } from './list-entry-row';
import { isSameIdSet, renumber } from './list-order';
import { LIST_MAX_ENTRIES } from './list.constants';
import {
  gameNotFound,
  gameReleaseNotFound,
  listEntryExists,
  listEntryNotFound,
  listEntryOneTarget,
  listEntryOrderStale,
  listEntryReleaseMismatch,
  listEntryReleaseNeedsPlatformGame,
  listFull,
  listNotFound,
  listPriorityWishlistOnly,
  nothingToUpdate,
  platformGameNotFound,
} from './list.errors';

/** The order a list's owner chose; `id` breaks ties so a page never reshuffles. */
const LIST_ENTRY_ORDER = [{ position: 'asc' }, { id: 'asc' }] satisfies Prisma.ListEntryOrderByWithRelationInput[];

/**
 * The two uniques that keep a game, and a platform game, to one entry per
 * list, in every spelling a P2002 identity reports them (see
 * `identifiesConstraint`): the index names Prisma gave them, the raw columns,
 * and the Prisma fields.
 */
const LIST_ENTRY_UNIQUE_SPELLINGS = [
  ['list_entries_list_id_game_id_key'],
  ['list_entries_list_id_platform_game_id_key'],
  ['list_id', 'game_id'],
  ['list_id', 'platform_game_id'],
  ['listId', 'gameId'],
  ['listId', 'platformGameId'],
] as const;

/** What a new entry names: a game on any platform, or one platform game. */
type EntryTarget =
  | { readonly gameId: string; readonly platformGameId?: never }
  | { readonly platformGameId: string; readonly gameId?: never };

/**
 * The one thing a new entry names, or `LIST_ENTRY_ONE_TARGET` (#1241). A JSON
 * `null` names nothing, as an omitted id does. The database's
 * `list_entries_one_target` holds the same rule; checking it here first means
 * a client never meets that refusal.
 */
function targetOf({ gameId, platformGameId }: CreateListEntryDto): EntryTarget {
  if (gameId != null && platformGameId == null) {
    return { gameId };
  }

  if (platformGameId != null && gameId == null) {
    return { platformGameId };
  }

  throw listEntryOneTarget();
}

/**
 * A list's entries: a game on any platform or one platform game, in the order
 * the list's owner chose, with a priority on the wishlist alone (#1241).
 *
 * Every write is one interactive transaction that first touches the list's
 * row under the `update:list` ceiling ({@link lockList}). The touch is an
 * UPDATE, so it takes the row's lock until the transaction ends, and every
 * entry writer on one list waits its turn behind it. That is what makes the
 * append position, `LIST_FULL` and the reorder's check against the list's
 * entries exact: no other add, update, remove or reorder on the list can land
 * between this writer's reads and its write. Only cascades bypass it: an entry
 * goes with its game or platform game, and the reorder answers that with
 * `LIST_ORDER_STALE` too.
 */
@Injectable()
export class ListEntryService {
  private readonly logger = new Logger(ListEntryService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
    private readonly scopeComposer: ScopeComposer,
  ) {}

  /**
   * One page of a list's entries, in order. The list is read first, under the
   * list read ceiling, which also records the `List` scope `paginated()`
   * checks; a list the actor can't see is a 404 before any entry is read
   * (#1241).
   *
   * The entries are then a top-level read by `listId`, not a relation filter
   * under the list: Prisma drops a deny-all ceiling inside one
   * (docs/agents/gotchas.md). The rows and the count share a REPEATABLE READ
   * snapshot, so the total never disagrees with the rows (#230).
   */
  async list(listId: string, pagination: PaginationQueryDto): Promise<PaginatedRows<ListEntryDto>> {
    const list = await this.db.list.findFirst({
      where: this.scopeComposer.compose(ResourceType.List, Action.read, { id: listId }),
      select: { id: true },
    });

    if (!list) {
      throw listNotFound(listId);
    }

    const where = { listId } satisfies Prisma.ListEntryWhereInput;
    const [rows, total] = await this.db.$transaction(
      [
        this.db.listEntry.findMany({
          where,
          select: LIST_ENTRY_SELECT,
          orderBy: LIST_ENTRY_ORDER,
          skip: pagination.skip,
          take: pagination.pageSize,
        }),
        this.db.listEntry.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows, total };
  }

  /**
   * Put a game, or a platform game, at the end of a list. The actor must be
   * able to read the game (a platform game's game, for a platform game), and
   * each rule the database also holds is checked first, so a client meets a
   * coded refusal rather than the database's (#1241). Behind the list's lock,
   * the count and the last position are exact.
   */
  async add(listId: string, dto: CreateListEntryDto): Promise<ListEntryDto> {
    const { releaseId, note, priority } = dto;
    const target = targetOf(dto);

    if (releaseId != null && target.platformGameId === undefined) {
      throw listEntryReleaseNeedsPlatformGame();
    }

    return this.db.$transaction(async (tx) => {
      const { kind } = await this.lockList(tx, listId);
      this.assertPriorityFits(kind, priority);

      await this.assertTargetReadable(tx, target);
      if (releaseId != null && target.platformGameId !== undefined) {
        await this.assertReleaseBelongsTo(tx, releaseId, target.platformGameId);
      }

      const held = await tx.listEntry.aggregate({
        where: { listId },
        _count: { _all: true },
        _max: { position: true },
      });

      if (held._count._all >= LIST_MAX_ENTRIES) {
        throw listFull(LIST_MAX_ENTRIES);
      }

      try {
        return await tx.listEntry.create({
          data: { listId, ...target, releaseId, note, priority, position: (held._max.position ?? -1) + 1 },
          select: LIST_ENTRY_SELECT,
        });
      } catch (error) {
        throw this.addFailure(error, target);
      }
    });
  }

  /**
   * Patch an entry's note, priority or release. Omitted fields are preserved
   * and an explicit `null` clears one. A release is checked against the
   * entry's own platform game, read within the list, so a client never meets
   * the database's refusal (#1241).
   */
  async update(listId: string, entryId: string, dto: UpdateListEntryDto): Promise<ListEntryDto> {
    const data = pickDefined(dto);
    if (Object.keys(data).length === 0) {
      throw nothingToUpdate();
    }

    return this.db.$transaction(async (tx) => {
      const { kind } = await this.lockList(tx, listId);
      this.assertPriorityFits(kind, data.priority);

      if (data.releaseId != null) {
        const entry = await tx.listEntry.findUnique({
          where: { id: entryId, listId },
          select: { platformGameId: true },
        });

        if (!entry) {
          throw listEntryNotFound(entryId);
        }

        if (entry.platformGameId === null) {
          throw listEntryReleaseNeedsPlatformGame();
        }

        await this.assertReleaseBelongsTo(tx, data.releaseId, entry.platformGameId);
      }

      try {
        return await tx.listEntry.update({ where: { id: entryId, listId }, data, select: LIST_ENTRY_SELECT });
      } catch (error) {
        throw this.mapMissingToNotFound(error, entryId);
      }
    });
  }

  /**
   * Take an entry off a list. The positions after it keep their gap: the
   * order only compares them, and the next reorder renumbers from 0.
   */
  async remove(listId: string, entryId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await this.lockList(tx, listId);

      try {
        await tx.listEntry.delete({ where: { id: entryId, listId } });
      } catch (error) {
        throw this.mapMissingToNotFound(error, entryId);
      }
    });
  }

  /**
   * Put a list's entries in the order given: positions 0..n-1. The request
   * must name exactly the entries the list holds, compared as sets, or
   * nothing is written and the answer is `LIST_ORDER_STALE` (#1241).
   *
   * Behind the list's lock no other entry writer can add or remove one
   * between the check and the write, and every position is written in one
   * statement, so the reorder lands whole or not at all. A cascade from a
   * deleted game can still take an entry in between; the statement then
   * renumbers fewer rows than it was given, and that is the same stale order.
   */
  async reorder(listId: string, { entryIds }: ReorderListEntriesDto): Promise<ListEntryDto[]> {
    return this.db.$transaction(async (tx) => {
      await this.lockList(tx, listId);

      const held = await tx.listEntry.findMany({ where: { listId }, select: { id: true } });
      const heldIds = held.map(({ id }) => id);

      if (!isSameIdSet(heldIds, entryIds)) {
        throw listEntryOrderStale();
      }

      if (entryIds.length > 0) {
        const renumbered = await tx.$executeRaw(renumber('entries', listId, entryIds, new Date()));

        if (renumbered !== entryIds.length) {
          throw listEntryOrderStale();
        }
      }

      return tx.listEntry.findMany({ where: { listId }, select: LIST_ENTRY_SELECT, orderBy: LIST_ENTRY_ORDER });
    });
  }

  /**
   * Touches the list's row under the `update:list` ceiling, inside the
   * given transaction, and returns the list's kind. A list the actor can't
   * write matches no row: 404, as a missing one is.
   *
   * The touch is the lock every entry writer takes first: an UPDATE holds the
   * row until the transaction ends, so writers on one list run one at a time,
   * and each one's reads see what the one before it wrote. It also marks the
   * list as changed, since its entries are part of it.
   */
  private async lockList(tx: Prisma.TransactionClient, listId: string): Promise<{ kind: ListKind }> {
    try {
      return await tx.list.update({
        where: {
          id: listId,
          // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.List, Action.update),
        },
        data: { updatedAt: new Date() },
        select: { kind: true },
      });
    } catch (error) {
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw listNotFound(listId);
      }

      throw error;
    }
  }

  /** A priority is the wishlist's alone; clearing one (`null`) is no priority, so any list takes it. */
  private assertPriorityFits(kind: ListKind, priority: WishlistPriority | null | undefined): void {
    if (priority != null && kind !== ListKind.Wishlist) {
      throw listPriorityWishlistOnly();
    }
  }

  /**
   * The actor may put on a list only a game they could read: for a platform
   * game, its game. A miss answers as what the entry named, missing or not
   * theirs to see alike. Both reads are top-level, since a ceiling inside a
   * relation filter fails open (`bge/no-nested-ceiling`).
   */
  private async assertTargetReadable(tx: Prisma.TransactionClient, target: EntryTarget): Promise<void> {
    if (target.platformGameId === undefined) {
      if (!(await this.isGameReadable(tx, target.gameId))) {
        throw this.targetNotFound(target);
      }

      return;
    }

    const platformGame = await tx.platformGame.findUnique({
      where: { id: target.platformGameId },
      select: { id: true, gameId: true },
    });

    if (!platformGame || !(await this.isGameReadable(tx, platformGame.gameId))) {
      throw this.targetNotFound(target);
    }
  }

  private async isGameReadable(tx: Prisma.TransactionClient, gameId: string): Promise<boolean> {
    const game = await tx.game.findFirst({
      where: this.scopeComposer.compose(ResourceType.Game, Action.read, { id: gameId, deletedAt: null }),
      select: { id: true },
    });

    return game !== null;
  }

  private targetNotFound(target: EntryTarget): CodedHttpException {
    return target.platformGameId === undefined
      ? gameNotFound(target.gameId)
      : platformGameNotFound(target.platformGameId);
  }

  /**
   * A release names the platform game it belongs to. The database refuses
   * any other (the `list_entries_release_match` trigger) with free text, so
   * it is checked here first.
   */
  private async assertReleaseBelongsTo(
    tx: Prisma.TransactionClient,
    releaseId: string,
    platformGameId: string,
  ): Promise<void> {
    const release = await tx.gameRelease.findUnique({
      where: { id: releaseId },
      select: { platformGameId: true },
    });

    if (!release) {
      throw gameReleaseNotFound(releaseId);
    }

    if (release.platformGameId !== platformGameId) {
      throw listEntryReleaseMismatch(releaseId, platformGameId);
    }
  }

  /**
   * An insert's failure, as the client should hear it:
   *
   * - A unique violation on either of the entry's uniques is the game, or
   *   platform game, already on the list. One whose constraint can't be named
   *   is answered the same: the table's only other unique is its generated
   *   primary key.
   * - A foreign key violation is what the entry named going between the
   *   readability read and the insert: games and platform games are read
   *   without a lock, and a release goes only with its platform game. The
   *   list can't go, since this transaction holds its row.
   */
  private addFailure(error: unknown, target: EntryTarget): unknown {
    if (isPrismaUniqueConstraintError(error)) {
      const identity = constraintIdentity(error);

      if (identity.source === 'unknown' || identifiesConstraint(identity, ...LIST_ENTRY_UNIQUE_SPELLINGS)) {
        return listEntryExists();
      }

      this.logger.error(`List entry insert hit an unexpected unique: ${JSON.stringify(identity)}`, error);
      return error;
    }

    if (isPrismaForeignKeyConstraintError(error)) {
      return this.targetNotFound(target);
    }

    return error;
  }

  /**
   * The write matched no entry with this id on this list: missing, or on
   * another list. Both are a 404 about the entry.
   */
  private mapMissingToNotFound(error: unknown, entryId: string): Error {
    if (isPrismaDependentRecordNotFoundError(error)) {
      return listEntryNotFound(entryId);
    }

    this.logger.error(`Error mutating list entry with id ${entryId}`, error);
    return error instanceof Error ? error : new Error(String(error));
  }
}
