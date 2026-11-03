import { Action, DatabaseService, Prisma, type Reach, ResourceType } from '@bge/database';
import { ScopeComposer, Unscoped } from '@bge/permissions';
import { escapeLikePattern, type PaginatedRows } from '@bge/shared';
import { Injectable } from '@nestjs/common';
import { ADMIN_HOUSEHOLD_ROW_SELECT } from '../read-shapes';
import type {
  AdminHouseholdListQueryDto,
  AdminHouseholdSort,
  AdminHouseholdStatus,
} from './admin-household-list.query.dto';

/** A household owner as one row of the staff households list names them (#419). */
export interface AdminHouseholdOwner {
  readonly userId: string;
  readonly username: string;
  /** The profile's display name as stored: null when the user has none, or has no profile. */
  readonly displayName: string | null;
}

/** One row of the staff households list (#419). */
export interface AdminHouseholdRow {
  readonly id: string;
  readonly name: string;
  readonly image: string | null;
  readonly reach: Reach;
  readonly createdAt: Date;
  readonly deletedAt: Date | null;
  readonly memberCount: number;
  readonly owners: readonly AdminHouseholdOwner[];
}

/**
 * The staff households list is every household on the server, by design. The
 * read names no set of its own, so its ceiling decides alone, and it is still
 * composed: the actor's ceiling is ANDed in, and the read is recorded for the
 * envelope's guard.
 */
export const ADMIN_HOUSEHOLD_LIST_SCOPE = Unscoped(
  'the staff households list is every household on the server by design (#419): staff reach it through their ' +
    'read on every resource, and the ceiling is ANDed in all the same',
);

/** What each `status` adds beside the ceiling. `all` adds nothing. */
const STATUS_FILTERS: Record<AdminHouseholdStatus, Prisma.HouseholdWhereInput[]> = {
  live: [{ deletedAt: null }],
  deleted: [{ deletedAt: { not: null } }],
  all: [],
};

/**
 * Each `sort` as an order. Every order ends in the household id, so rows tied
 * on the first key keep one order between requests and cannot drift across a
 * page boundary.
 */
const ADMIN_HOUSEHOLD_ORDERS: Record<AdminHouseholdSort, Prisma.HouseholdOrderByWithRelationInput[]> = {
  name: [{ name: 'asc' }, { id: 'asc' }],
  newest: [{ createdAt: 'desc' }, { id: 'desc' }],
  members: [{ members: { _count: 'desc' } }, { id: 'desc' }],
  // Postgres puts NULLs first in a descending sort, so without `nulls: 'last'`
  // every live household would lead the "most recently deleted" order under
  // `status=all` (#419).
  deleted: [{ deletedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
};

/**
 * The staff households list, `GET /admin/households` (#419). Kept apart from
 * `HouseholdService`, whose reads answer for the acting user's own
 * households: this one answers for the server.
 */
@Injectable()
export class AdminHouseholdService {
  constructor(
    private readonly db: DatabaseService,
    private readonly scopeComposer: ScopeComposer,
  ) {}

  /**
   * One page of households, live or deleted, with the total for the envelope
   * (#230).
   *
   * The ceiling comes from {@link ADMIN_HOUSEHOLD_LIST_SCOPE}, and `status`
   * and `q` are filters beside it, never a scope: they narrow which
   * households the request asks for, not what the actor may see.
   *
   * Rows and count share one REPEATABLE READ snapshot, so a household created
   * or deleted between the two cannot make `total` disagree with the rows.
   */
  async listHouseholds(query: AdminHouseholdListQueryDto): Promise<PaginatedRows<AdminHouseholdRow>> {
    const where: Prisma.HouseholdWhereInput = {
      AND: [
        this.scopeComposer.compose(ResourceType.Household, Action.read, ADMIN_HOUSEHOLD_LIST_SCOPE),
        ...STATUS_FILTERS[query.status],
        ...(query.q === undefined ? [] : [this.searchFilter(query.q)]),
      ],
    };

    const [rows, total] = await this.db.$transaction(
      [
        this.db.household.findMany({
          where,
          select: ADMIN_HOUSEHOLD_ROW_SELECT,
          orderBy: ADMIN_HOUSEHOLD_ORDERS[query.sort],
          skip: query.skip,
          take: query.pageSize,
        }),
        this.db.household.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return {
      rows: rows.map(({ _count, members, ...household }) => ({
        ...household,
        memberCount: _count.members,
        owners: members.map(({ userId, user }) => ({
          userId,
          username: user.username,
          displayName: user.profile?.displayName ?? null,
        })),
      })),
      total,
    };
  }

  /**
   * A household whose name, or one of whose members' username or display
   * name, contains `q`, ignoring case. The member half is a `some`, so a
   * household matched through several members, or through its name and a
   * member at once, is still one row.
   *
   * `q` is escaped, so `%`, `_` and `\` match only themselves rather than
   * acting as `LIKE` wildcards (#419).
   */
  private searchFilter(q: string): Prisma.HouseholdWhereInput {
    const matches = { contains: escapeLikePattern(q), mode: 'insensitive' } as const;

    return {
      OR: [
        { name: matches },
        { members: { some: { user: { OR: [{ username: matches }, { profile: { displayName: matches } }] } } } },
      ],
    };
  }
}
