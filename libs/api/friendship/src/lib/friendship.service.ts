import {
  Action,
  DatabaseService,
  type Friendship,
  FriendshipStatus,
  isPrismaDependentRecordNotFoundError,
  isPrismaUniqueConstraintError,
  Prisma,
  ResourceType,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, resolveScopeSubjectId, ScopeComposer } from '@bge/permissions';
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
import { ExtendedNetworkProducer } from './extended-network/extended-network.producer';

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
    private readonly scopeComposer: ScopeComposer,
    private readonly extendedNetwork: ExtendedNetworkProducer,
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
   * The acting user's friendships, in either direction, newest activity first,
   * optionally narrowed to one status. One page plus the total for the
   * envelope (#372).
   *
   * The scope is the acting user's friendships, and the ceiling only clips it
   * (#515). Before, the ceiling was the whole answer, so staff and the Owner,
   * who read every friendship on the server, got everyone's. The status filter
   * is a query parameter, so it sits beside the composed clause rather than
   * inside it.
   *
   * `resolveScopeSubjectId` refuses `plugin`, `system` and `external` actors:
   * "my friendships" has no meaning without a user, and the refusal must never
   * soften into an empty page. PROVISIONAL — #395.
   */
  async listForUser(query: ListFriendshipsQueryDto): Promise<PaginatedRows<FriendshipWithParticipants>> {
    const { status } = query;
    const userId = resolveScopeSubjectId(this.abilityService);

    return this.paginateFriendships(
      {
        AND: [
          this.scopeComposer.compose(ResourceType.Friendship, Action.read, {
            OR: [{ requesterId: userId }, { addresseeId: userId }],
          }),
          status ? { status } : {},
        ],
      },
      // `id` breaks ties on `updatedAt`: a batch status change stamps several
      // rows identically, which a tie-less sort lets drift across pages.
      [{ updatedAt: 'desc' }, { id: 'desc' }],
      query,
    );
  }

  /**
   * Incoming pending requests where the acting user is the addressee. The
   * scope already named the addressee, so composing it (#515) changes no rows;
   * it is what the envelope's guard checks for.
   *
   * Takes the bare page contract, not `ListFriendshipsQueryDto`: this set is
   * Pending by definition, so there is no status to filter on, and the route
   * binds a status-less DTO for the same reason.
   */
  async listIncomingRequests(query: PaginationQueryDto): Promise<PaginatedRows<FriendshipWithParticipants>> {
    const userId = resolveScopeSubjectId(this.abilityService);

    return this.paginateFriendships(
      this.scopeComposer.compose(ResourceType.Friendship, Action.read, {
        addresseeId: userId,
        status: FriendshipStatus.Pending,
      }),
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
   *
   * A transition from Pending writes only while the row is still Pending, so
   * a response that a concurrent one overtook is refused as no longer
   * pending rather than written over it: a withdrawal never undoes an accept.
   *
   * Once written, an accept or a block queues a rebuild of the extended network table
   * around both users (#497). Those are the responses that can add or end an
   * accepted friendship, the only kind of step the table counts. A decline or
   * a withdrawal moves a row that the guarded write proves was Pending, so it
   * queues nothing. A block can end a friendship from any status, so it
   * always queues; it takes effect at once, since the permissions check
   * blocks themselves.
   */
  async respond(id: string, status: RespondableFriendshipStatus) {
    const userId = this.abilityService.getActingUserId();
    const friendship = await this.getParticipantFriendship(id);

    const isAddressee = friendship.addresseeId === userId;
    const isRequester = friendship.requesterId === userId;

    const data: Prisma.FriendshipUpdateInput = { status, respondedAt: new Date() };
    let fromPending = false;

    switch (status) {
      case FriendshipStatus.Accepted:
      case FriendshipStatus.Declined:
        if (!isAddressee) {
          throw new ForbiddenException(t('errors.friendship.only_recipient_responds'));
        }
        if (friendship.status !== FriendshipStatus.Pending) {
          throw new BadRequestException(t('errors.friendship.not_pending'));
        }
        fromPending = true;
        break;

      case FriendshipStatus.Withdrawn:
        if (!isRequester) {
          throw new ForbiddenException(t('errors.friendship.only_sender_withdraws'));
        }
        if (friendship.status !== FriendshipStatus.Pending) {
          throw new BadRequestException(t('errors.friendship.not_pending'));
        }
        fromPending = true;
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

    const updated = await this.updateScoped(id, data, fromPending ? FriendshipStatus.Pending : undefined);
    if (status === FriendshipStatus.Accepted || status === FriendshipStatus.Blocked) {
      // Not awaited: queueing never rejects, but it hangs while the queue's
      // Redis is unreachable, and the friendship is already written.
      void this.extendedNetwork.changed([updated.requesterId, updated.addresseeId]);
    }

    return updated;
  }

  /**
   * Remove a friendship (unfriend, or unblock by the blocker). A blocked user
   * cannot delete the row to escape the block — only the blocker (recorded as
   * the `requester` of a Blocked row) may.
   *
   * Once written, an unfriend queues a rebuild of the extended network table around
   * both users (#497): it takes a reader out of the extended network only
   * when that rebuild runs. The status comes from the deleted row itself, so
   * an unblock or a removed request, which ends no accepted friendship,
   * queues nothing.
   */
  async remove(id: string) {
    const userId = this.abilityService.getActingUserId();
    const friendship = await this.getParticipantFriendship(id);

    if (friendship.status === FriendshipStatus.Blocked && friendship.requesterId !== userId) {
      throw new ForbiddenException(t('errors.friendship.cannot_remove_blocker'));
    }

    let removed: Friendship;
    try {
      removed = await this.db.friendship.delete({
        where: {
          id,
          // eslint-disable-next-line no-restricted-syntax -- single-row delete by id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.Friendship, Action.delete),
        },
      });
    } catch (error) {
      throw this.mapMissingToForbidden(error, id);
    }

    if (removed.status === FriendshipStatus.Accepted) {
      // Not awaited, as in `respond`.
      void this.extendedNetwork.changed([removed.requesterId, removed.addresseeId]);
    }

    return removed;
  }

  /**
   * Writes `data` to a row the actor may change. With `expectedStatus`, only
   * while the row still has it: the caller read it there, and a row that left
   * it since was moved by a concurrent response. The caller already read the
   * row as a participant, which no response changes, so a miss under the
   * guard means the status moved, or the row is gone.
   */
  private async updateScoped(id: string, data: Prisma.FriendshipUpdateInput, expectedStatus?: FriendshipStatus) {
    try {
      return await this.db.friendship.update({
        where: {
          id,
          ...(expectedStatus && { status: expectedStatus }),
          // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.Friendship, Action.update),
        },
        data,
        include: PARTICIPANT_INCLUDE,
      });
    } catch (error) {
      if (expectedStatus === FriendshipStatus.Pending && isPrismaDependentRecordNotFoundError(error)) {
        throw new BadRequestException(t('errors.friendship.not_pending'));
      }

      throw this.mapMissingToForbidden(error, id);
    }
  }

  /** Loads a friendship the acting user participates in, or throws 404. */
  private async getParticipantFriendship(id: string) {
    const friendship = await this.db.friendship.findUnique({
      where: {
        id,
        // eslint-disable-next-line no-restricted-syntax -- single-row fetch by id, not a collection read
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
