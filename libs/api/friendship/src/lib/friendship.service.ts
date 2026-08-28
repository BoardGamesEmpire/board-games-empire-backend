import {
  Action,
  DatabaseService,
  FriendshipStatus,
  isPrismaDependentRecordNotFoundError,
  isPrismaUniqueConstraintError,
  Prisma,
  ResourceType,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService } from '@bge/permissions';
import type { PaginatedRows, PaginationQueryDto } from '@bge/shared';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreateFriendRequestDto, ListFriendshipsQueryDto, RespondableFriendshipStatus } from './dto';

/**
 * Both participants, as every friendship read returns them. Extracted to module
 * scope so the payload type below stays in step with what the queries select.
 */
const PARTICIPANT_INCLUDE = {
  requester: { select: { id: true, username: true, profile: { select: { avatarUrl: true, displayName: true } } } },
  addressee: { select: { id: true, username: true, profile: { select: { avatarUrl: true, displayName: true } } } },
} satisfies Prisma.FriendshipInclude;

export type FriendshipWithParticipants = Prisma.FriendshipGetPayload<{ include: typeof PARTICIPANT_INCLUDE }>;

@Injectable()
export class FriendshipService {
  private readonly logger = new Logger(FriendshipService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
  ) {}

  /**
   * Send a friend request. A friendship is always a single row per unordered
   * pair, so an existing row between the two users is rejected or repurposed
   * regardless of direction:
   * - Accepted / Pending   → rejected (already friends / request outstanding)
   * - Blocked              → rejected (either party has blocked the other)
   * - Declined / Withdrawn → repurposed into a fresh Pending request from the
   *   acting user.
   *
   * The reject-or-repurpose decision is a check-then-act that cannot be atomic
   * on its own, so the write is an `upsert` keyed on the unique `pairKey`, but
   * its `where` also pins the row to the two repurposable statuses
   * (`Declined`/`Withdrawn`). This makes the reactivation decision atomic rather
   * than trusting the possibly-stale switch above: if a concurrent request has
   * moved the row to `Pending`/`Accepted`/`Blocked` since we read it, the update
   * branch no longer matches, Prisma falls through to `create`, and the
   * `pairKey` unique constraint is hit — mapped to a 409 instead of silently
   * clobbering that row's status back to `Pending`. The unique collision on a
   * genuine concurrent create (neither side saw a row) is mapped the same way.
   * The whole operation is gated by `create` authority (reactivation is a new
   * request, not an edit of someone's existing row — the `pairKey` can only
   * match a row the acting user is already part of), so it deliberately does not
   * apply update-scoping.
   */
  async create({ addresseeId, message }: CreateFriendRequestDto) {
    const requesterId = this.abilityService.getActingUserId();

    if (requesterId === addresseeId) {
      throw new BadRequestException(t('errors.friendship.self_request'));
    }

    const addressee = await this.db.user.findUnique({
      where: { id: addresseeId },
      select: { id: true, preferences: { select: { allowFriendRequests: true } } },
    });

    if (!addressee) {
      throw new NotFoundException(t('errors.user.not_found', { id: addresseeId }));
    }

    // Absent preferences row → treat as the schema default (true).
    if (addressee.preferences?.allowFriendRequests === false) {
      throw new ForbiddenException(t('errors.friendship.requests_disabled'));
    }

    const existing = await this.findBetween(requesterId, addresseeId);

    switch (existing?.status) {
      case FriendshipStatus.Accepted:
        throw new BadRequestException(t('errors.friendship.already_friends'));
      case FriendshipStatus.Pending:
        throw new BadRequestException(t('errors.friendship.already_pending'));
      case FriendshipStatus.Blocked:
        throw new ForbiddenException(t('errors.friendship.cannot_request'));
    }

    const pairKey = FriendshipService.pairKey(requesterId, addresseeId);
    // `message ?? null` clears any text left on a prior declined/withdrawn row
    // (Prisma treats `undefined` as "leave unchanged").
    const requestData = { requesterId, addresseeId, status: FriendshipStatus.Pending, message: message ?? null };

    try {
      return await this.db.friendship.upsert({
        // The status filter guards the update branch: it only reactivates a row
        // still in a repurposable state, so a concurrently-created Pending or a
        // just-set Blocked/Accepted row can't be silently flipped back.
        where: { pairKey, status: { in: [FriendshipStatus.Declined, FriendshipStatus.Withdrawn] } },
        create: { ...requestData, pairKey },
        update: { ...requestData, respondedAt: null },
        include: PARTICIPANT_INCLUDE,
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        throw new ConflictException(t('errors.friendship.already_exists'));
      }
      throw error;
    }
  }

  /**
   * Every friendship visible to the caller, newest activity first, optionally
   * narrowed to one status. One page plus the total for the envelope (#372).
   */
  async listForUser(query: ListFriendshipsQueryDto): Promise<PaginatedRows<FriendshipWithParticipants>> {
    const { status } = query;

    return this.paginateFriendships(
      {
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.Friendship, Action.read),
        ...(status ? { status } : {}),
      },
      // `id` breaks ties on `updatedAt`: a batch status change stamps several
      // rows identically, which a tie-less sort lets drift across pages.
      [{ updatedAt: 'desc' }, { id: 'desc' }],
      query,
    );
  }

  /** Incoming pending requests where the acting user is the addressee. */
  async listIncomingRequests(query: ListFriendshipsQueryDto): Promise<PaginatedRows<FriendshipWithParticipants>> {
    const userId = this.abilityService.getActingUserId();

    return this.paginateFriendships(
      {
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.Friendship, Action.read),
        addresseeId: userId,
        status: FriendshipStatus.Pending,
      },
      [{ createdAt: 'desc' }, { id: 'desc' }],
      query,
    );
  }

  /**
   * The shared read behind both list endpoints: one page of friendships plus
   * the total matching row count for the response envelope (#372). Scope and
   * sort key are each read's business; everything else here is invariant, and
   * shared so a fix to either cannot land on one read and miss the other.
   *
   * Rows and count share a REPEATABLE READ transaction: under the database
   * default each statement takes its own snapshot, and a request accepted
   * between the two — which this list is precisely the view of — makes
   * `hasMore` disagree with the rows actually sent.
   */
  private async paginateFriendships(
    where: Prisma.FriendshipWhereInput,
    orderBy: Prisma.FriendshipOrderByWithRelationInput[],
    pagination: PaginationQueryDto,
  ): Promise<PaginatedRows<FriendshipWithParticipants>> {
    const [rows, total] = await this.db.$transaction(
      [
        this.db.friendship.findMany({
          where,
          include: PARTICIPANT_INCLUDE,
          orderBy,
          skip: pagination.skip,
          take: pagination.pageSize,
        }),

        this.db.friendship.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows, total };
  }

  /**
   * Apply a status transition to a friendship. Enforces which participant may
   * apply which transition:
   * - Accepted / Declined — addressee only, from Pending
   * - Withdrawn           — requester only, from Pending
   * - Blocked             — either participant, from any non-Blocked state; the
   *   row is reoriented so the blocker becomes the `requester` (so only the
   *   blocker can later unblock via {@link remove}).
   */
  async respond(id: string, status: RespondableFriendshipStatus) {
    const userId = this.abilityService.getActingUserId();
    const friendship = await this.getParticipantFriendship(id);

    const isAddressee = friendship.addresseeId === userId;
    const isRequester = friendship.requesterId === userId;

    const data: Prisma.FriendshipUpdateInput = { status, respondedAt: new Date() };

    switch (status) {
      case FriendshipStatus.Accepted:
      case FriendshipStatus.Declined:
        if (!isAddressee) {
          throw new ForbiddenException(t('errors.friendship.only_recipient_responds'));
        }
        if (friendship.status !== FriendshipStatus.Pending) {
          throw new BadRequestException(t('errors.friendship.not_pending'));
        }
        break;

      case FriendshipStatus.Withdrawn:
        if (!isRequester) {
          throw new ForbiddenException(t('errors.friendship.only_sender_withdraws'));
        }
        if (friendship.status !== FriendshipStatus.Pending) {
          throw new BadRequestException(t('errors.friendship.not_pending'));
        }
        break;

      case FriendshipStatus.Blocked:
        if (friendship.status === FriendshipStatus.Blocked) {
          throw new BadRequestException(t('errors.friendship.already_blocked'));
        }
        // Reorient so the acting user (the blocker) is the requester.
        data.requester = { connect: { id: userId } };
        data.addressee = { connect: { id: isAddressee ? friendship.requesterId : friendship.addresseeId } };
        break;
    }

    return this.updateScoped(id, data);
  }

  /**
   * Remove a friendship (unfriend, or unblock by the blocker). A blocked user
   * cannot delete the row to escape the block — only the blocker (recorded as
   * the `requester` of a Blocked row) may.
   */
  async remove(id: string) {
    const userId = this.abilityService.getActingUserId();
    const friendship = await this.getParticipantFriendship(id);

    if (friendship.status === FriendshipStatus.Blocked && friendship.requesterId !== userId) {
      throw new ForbiddenException(t('errors.friendship.cannot_remove_blocker'));
    }

    try {
      return await this.db.friendship.delete({
        where: {
          id,
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.Friendship, Action.delete),
        },
      });
    } catch (error) {
      throw this.mapMissingToForbidden(error, id);
    }
  }

  private async updateScoped(id: string, data: Prisma.FriendshipUpdateInput) {
    try {
      return await this.db.friendship.update({
        where: {
          id,
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.Friendship, Action.update),
        },
        data,
        include: PARTICIPANT_INCLUDE,
      });
    } catch (error) {
      throw this.mapMissingToForbidden(error, id);
    }
  }

  /** Loads a friendship the acting user participates in, or throws 404. */
  private async getParticipantFriendship(id: string) {
    const friendship = await this.db.friendship.findUnique({
      where: {
        id,
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.Friendship, Action.read),
      },
    });

    if (!friendship) {
      throw new NotFoundException(t('errors.friendship.not_found', { id }));
    }

    return friendship;
  }

  /** Finds the single friendship row between two users, in either direction. */
  private findBetween(a: string, b: string) {
    return this.db.friendship.findUnique({ where: { pairKey: FriendshipService.pairKey(a, b) } });
  }

  /** Canonical undirected-pair key — identical for both directions of a pair. */
  private static pairKey(a: string, b: string): string {
    return [a, b].sort().join(':');
  }

  private mapMissingToForbidden(error: unknown, id: string) {
    this.logger.error(`Error mutating friendship with id ${id}`, error);
    // The scoped `where` matched no row the actor may modify.
    if (isPrismaDependentRecordNotFoundError(error)) {
      return new ForbiddenException(t('errors.friendship.forbidden_modify'));
    }

    return error instanceof Error ? error : new Error(String(error));
  }
}
