import {
  Action,
  DatabaseService,
  isPrismaDependentRecordNotFoundError,
  ListKind,
  Prisma,
  ResourceType,
} from '@bge/database';
import { AbilityService, resolveScopeSubjectId, ScopeComposer } from '@bge/permissions';
import { PaginatedRows, PaginationQueryDto, pickDefined } from '@bge/shared';
import { Injectable, Logger } from '@nestjs/common';
import { CreateListDto, ListDto, ReorderListsDto, UpdateListDto } from './dto';
import { isSameIdSet, renumber } from './list-order';
import { LIST_SELECT, type ListRow } from './list-row';
import { LISTS_MAX_PER_USER } from './list.constants';
import {
  listLimitReached,
  listNameRequired,
  listNotFound,
  listOrderForbidden,
  listOrderStale,
  nothingToUpdate,
  wishlistUndeletable,
} from './list.errors';

/** The order a user chose for their lists; `id` breaks ties so a page never reshuffles. */
const LIST_ORDER = [{ position: 'asc' }, { id: 'asc' }] satisfies Prisma.ListOrderByWithRelationInput[];

/** A row as the routes send it: the relation count read as a plain `entryCount`. */
function toListDto({ _count, ...row }: ListRow): ListDto {
  return { ...row, entryCount: _count.entries };
}

/**
 * Each method that returns lists is annotated with the DTO the routes
 * document, and the DTO implements the row's type, so a field missing on
 * either side fails the typecheck (#1241).
 */
@Injectable()
export class ListService {
  private readonly logger = new Logger(ListService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
    private readonly scopeComposer: ScopeComposer,
  ) {}

  /**
   * The acting user's own lists, in the order they chose. The scope is their
   * lists, and the ceiling only clips it (#365). `resolveScopeSubjectId`
   * refuses an actor that is no user, rather than letting "my lists" soften
   * into an empty page.
   */
  async listOwn(query: PaginationQueryDto): Promise<PaginatedRows<ListDto>> {
    const userId = resolveScopeSubjectId(this.abilityService);

    return this.paginate(this.scopeComposer.compose(ResourceType.List, Action.read, { userId }), query);
  }

  /**
   * Another user's lists, clipped to what the acting user may see through the
   * list reach rules. The scope is the path user's lists; the viewer's ceiling
   * does the clipping. Anonymous users hold no list permission, so the policy
   * guard refuses them before this runs (#1241).
   */
  async listForUser(targetUserId: string, query: PaginationQueryDto): Promise<PaginatedRows<ListDto>> {
    return this.paginate(this.scopeComposer.compose(ResourceType.List, Action.read, { userId: targetUserId }), query);
  }

  /**
   * One page of lists plus the total matching count for the envelope. The two
   * reads share a REPEATABLE READ snapshot, so the total never disagrees with
   * the rows, as in the collection (#230).
   */
  private async paginate(
    where: Prisma.ListWhereInput,
    pagination: PaginationQueryDto,
  ): Promise<PaginatedRows<ListDto>> {
    const [rows, total] = await this.db.$transaction(
      [
        this.db.list.findMany({
          where,
          select: LIST_SELECT,
          orderBy: LIST_ORDER,
          skip: pagination.skip,
          take: pagination.pageSize,
        }),
        this.db.list.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows: rows.map(toListDto), total };
  }

  /** A single list the acting user may read. */
  async getById(id: string): Promise<ListDto> {
    const list = await this.db.list.findUnique({
      where: {
        id,
        // eslint-disable-next-line no-restricted-syntax -- single-row fetch by id, not a collection read
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.List, Action.read),
      },
      select: LIST_SELECT,
    });

    if (!list) {
      throw listNotFound(id);
    }

    return toListDto(list);
  }

  /**
   * Add a custom list after the acting user's last one. The wishlist is made
   * at provisioning, so a list made here is never one.
   *
   * The count, the last position and the insert share one transaction and no
   * lock (#1241). Two creates racing may take the same position, which the
   * order's `id` tiebreak settles, or both pass `LISTS_MAX_PER_USER`, so a user
   * may end up over it by the number of requests in flight. Both are accepted:
   * the cap bounds growth rather than guarding an invariant. The lock that
   * would close the race is on the user's own row, so it would serialize only
   * that user's creates, but it would contend there with the auth writes that
   * row also takes.
   */
  async create(dto: CreateListDto): Promise<ListDto> {
    const userId = this.abilityService.getActingUserId();

    const list = await this.db.$transaction(async (tx) => {
      const held = await tx.list.aggregate({
        where: { userId },
        _count: { _all: true },
        _max: { position: true },
      });

      if (held._count._all >= LISTS_MAX_PER_USER) {
        throw listLimitReached(LISTS_MAX_PER_USER);
      }

      return tx.list.create({
        data: {
          userId,
          kind: ListKind.Custom,
          name: dto.name,
          description: dto.description,
          reach: dto.reach,
          position: (held._max.position ?? -1) + 1,
        },
        select: LIST_SELECT,
      });
    });

    return toListDto(list);
  }

  /**
   * Patch a list. Omitted fields are preserved and an explicit `null` clears
   * `name` or `description`. A custom list refuses a null name: only the
   * wishlist can go without one, because a client shows its own translated
   * "Wishlist" in its place (#1241). The kind is read first, under the same
   * ceiling as the write, so a list the actor can't see is a 404 before it is
   * a refusal about its kind.
   */
  async update(id: string, dto: UpdateListDto): Promise<ListDto> {
    const data = pickDefined(dto);
    if (Object.keys(data).length === 0) {
      throw nothingToUpdate();
    }

    if (data.name === null) {
      const existing = await this.db.list.findUnique({
        where: {
          id,
          // eslint-disable-next-line no-restricted-syntax -- single-row pre-read for a write by id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.List, Action.update),
        },
        select: { kind: true },
      });

      if (!existing) {
        throw listNotFound(id);
      }

      if (existing.kind !== ListKind.Wishlist) {
        throw listNameRequired();
      }
    }

    try {
      const list = await this.db.list.update({
        where: {
          id,
          // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.List, Action.update),
        },
        data,
        select: LIST_SELECT,
      });

      return toListDto(list);
    } catch (error) {
      throw this.mapMissingToNotFound(error, id);
    }
  }

  /**
   * Delete a custom list; its entries go with it (cascade). The wishlist is
   * refused, never deleted (#1241). The kind is read first under the delete
   * ceiling to tell the two refusals apart, and the delete restates
   * `kind: Custom`, so the wishlist stays safe even if the read raced.
   */
  async remove(id: string): Promise<void> {
    const existing = await this.db.list.findUnique({
      where: {
        id,
        // eslint-disable-next-line no-restricted-syntax -- single-row pre-read for a write by id, not a collection read
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.List, Action.delete),
      },
      select: { kind: true },
    });

    if (!existing) {
      throw listNotFound(id);
    }

    if (existing.kind === ListKind.Wishlist) {
      throw wishlistUndeletable();
    }

    try {
      await this.db.list.delete({
        where: {
          id,
          kind: ListKind.Custom,
          // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.List, Action.delete),
        },
      });
    } catch (error) {
      throw this.mapMissingToNotFound(error, id);
    }
  }

  /**
   * Put the acting user's lists in the order given: positions 0..n-1. The
   * request must name exactly the lists they hold, compared as sets, or
   * nothing is written and the answer is `LIST_ORDER_STALE` (#1241).
   *
   * The order spans every list the user holds, so the caller must be able to
   * change every one. A caller whose update ceiling admits only some, such as
   * an API key whose `update:list` grant is pinned to one list, is refused
   * with `LIST_ORDER_FORBIDDEN`: renumbering only the lists it may change
   * would give them positions the others already hold.
   *
   * Every position is written in one statement, so the reorder lands whole or
   * not at all, and no lock beyond the transaction is taken. A list deleted
   * between the check and the write leaves the statement renumbering fewer
   * rows than it was given, which is the same stale order.
   */
  async reorder({ listIds }: ReorderListsDto): Promise<ListDto[]> {
    const userId = resolveScopeSubjectId(this.abilityService);

    const lists = await this.db.$transaction(async (tx) => {
      const held = await tx.list.findMany({ where: { userId }, select: { id: true } });
      const writable = await tx.list.count({
        where: this.scopeComposer.compose(ResourceType.List, Action.update, { userId }),
      });

      if (writable !== held.length) {
        throw listOrderForbidden();
      }

      const heldIds = held.map(({ id }) => id);

      if (!isSameIdSet(heldIds, listIds)) {
        throw listOrderStale();
      }

      if (listIds.length > 0) {
        const renumbered = await tx.$executeRaw(renumber('lists', userId, listIds, new Date()));

        if (renumbered !== listIds.length) {
          throw listOrderStale();
        }
      }

      return tx.list.findMany({ where: { userId, id: { in: listIds } }, select: LIST_SELECT, orderBy: LIST_ORDER });
    });

    return lists.map(toListDto);
  }

  /**
   * The scoped `where` matched no row: missing, or outside the actor's CASL
   * scope. Both collapse to 404, so a foreign list is indistinguishable from an
   * absent one.
   */
  private mapMissingToNotFound(error: unknown, id: string): Error {
    if (isPrismaDependentRecordNotFoundError(error)) {
      return listNotFound(id);
    }

    this.logger.error(`Error mutating list with id ${id}`, error);
    return error instanceof Error ? error : new Error(String(error));
  }
}
