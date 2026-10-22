import { Action, DatabaseService, Prisma, ResourceType } from '@bge/database';
import { ScopeComposer } from '@bge/permissions';
import type { PaginatedRows } from '@bge/shared';
import { Injectable } from '@nestjs/common';
import { UserSearchQueryDto } from './dto/user-search-query.dto';
import type { UserSearchResult } from './interfaces/user-search-results.interface';

@Injectable()
export class UserService {
  constructor(
    private readonly db: DatabaseService,
    private readonly scopeComposer: ScopeComposer,
  ) {}

  async findById(id: string) {
    return this.db.user.findUnique({ where: { id } });
  }

  async findByEmail(email: string) {
    return this.db.user.findUnique({ where: { email } });
  }

  async findByUsername(username: string) {
    return this.db.user.findUnique({ where: { username } });
  }

  /**
   * One page of matching users plus the total number of matches, for the
   * response envelope (#372).
   *
   * The count is the same text match run twice, which is the cost this read
   * pays for a real `totalPages` (D-230-2 makes `total` unconditional). It is
   * accepted rather than approximated because a search UI showing "1 of 12
   * pages" is the whole point of paging a search; the match itself is three
   * case-insensitive `contains` predicates, one through a relation, so the
   * count is the expensive statement here and not the paging.
   *
   * Both statements share a REPEATABLE READ snapshot, so a user turning
   * searchable — or being banned — between them cannot make `hasMore` promise a
   * page the next request answers differently.
   *
   * The scope is the search itself: the opted-in, unbanned users the term
   * matches, the caller left out. The caller's ceilings only clip it (#517).
   * Each row carries its profile's name and avatar, so both `User` and
   * `UserProfile` are composed, the second on the profile the row carries.
   * Every user's `User` ceiling is `read:user:searchable`, which repeats the
   * opt-in and ban clauses. Their `UserProfile` one is their own profile, a
   * friend's that reaches friends, and every `Public` one, so a profile whose
   * reach shuts them out is not found: a profile is found only where it can
   * be read (#495). An API key scoped to
   * one user or one profile narrows the page to that user.
   */
  async searchUsers(requestingUserId: string, query: UserSearchQueryDto): Promise<PaginatedRows<UserSearchResult>> {
    const where = this.scopeComposer.compose(ResourceType.User, Action.read, {
      AND: [
        { banned: false },
        { id: { not: requestingUserId } },
        { profile: { is: this.scopeComposer.compose(ResourceType.UserProfile, Action.read, { isSearchable: true }) } },
        {
          OR: [
            { username: { contains: query.q, mode: 'insensitive' } },
            { firstName: { contains: query.q, mode: 'insensitive' } },
            { profile: { displayName: { contains: query.q, mode: 'insensitive' } } },
          ],
        },
      ],
    });

    const [rows, total] = await this.db.$transaction(
      [
        this.db.user.findMany({
          where,
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            // No `image`: the sign-in provider's picture only seeds the
            // avatar at provisioning, and the avatar served is the profile's
            // (#695).
            profile: {
              select: {
                displayName: true,
                avatarUrl: true,
              },
            },
          },
          take: query.pageSize,
          skip: query.skip,
          // `User.username` is `@unique`, so this is already a total order and
          // needs no tie-breaker of its own.
          orderBy: { username: 'asc' },
        }),

        this.db.user.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows, total };
  }
}
