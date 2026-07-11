import {
  Action,
  DatabaseService,
  FriendshipStatus,
  isPrismaDependentRecordNotFoundError,
  isPrismaUniqueConstraintError,
  Prisma,
  ResourceType,
} from '@bge/database';
import { AbilityService } from '@bge/permissions';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreateFriendRequestDto, ListFriendshipsQueryDto, RespondableFriendshipStatus } from './dto';

@Injectable()
export class FriendshipService {
  private readonly logger = new Logger(FriendshipService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
  ) {}

  private readonly participantInclude = {
    requester: { select: { id: true, username: true, profile: { select: { avatarUrl: true, displayName: true } } } },
    addressee: { select: { id: true, username: true, profile: { select: { avatarUrl: true, displayName: true } } } },
  } satisfies Prisma.FriendshipInclude;

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
      throw new BadRequestException('You cannot send a friend request to yourself');
    }

    const addressee = await this.db.user.findUnique({
      where: { id: addresseeId },
      select: { id: true, preferences: { select: { allowFriendRequests: true } } },
    });

    if (!addressee) {
      throw new NotFoundException(`User with id ${addresseeId} not found`);
    }

    // Absent preferences row → treat as the schema default (true).
    if (addressee.preferences?.allowFriendRequests === false) {
      throw new ForbiddenException('This user is not accepting friend requests');
    }

    const existing = await this.findBetween(requesterId, addresseeId);

    switch (existing?.status) {
      case FriendshipStatus.Accepted:
        throw new BadRequestException('You are already friends with this user');
      case FriendshipStatus.Pending:
        throw new BadRequestException('A friend request is already pending between you and this user');
      case FriendshipStatus.Blocked:
        throw new ForbiddenException('Unable to send a friend request to this user');
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
        include: this.participantInclude,
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        throw new ConflictException('A friend request already exists between you and this user');
      }
      throw error;
    }
  }

  async listForUser({ status, offset, limit }: ListFriendshipsQueryDto) {
    return this.db.friendship.findMany({
      where: {
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.Friendship, Action.read),
        ...(status ? { status } : {}),
      },
      include: this.participantInclude,
      orderBy: { updatedAt: 'desc' },
      skip: offset,
      take: limit || 10,
    });
  }

  /** Incoming pending requests where the acting user is the addressee. */
  async listIncomingRequests({ offset, limit }: ListFriendshipsQueryDto) {
    const userId = this.abilityService.getActingUserId();

    return this.db.friendship.findMany({
      where: {
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.Friendship, Action.read),
        addresseeId: userId,
        status: FriendshipStatus.Pending,
      },
      include: this.participantInclude,
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: limit || 10,
    });
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
          throw new ForbiddenException('Only the recipient can respond to a friend request');
        }
        if (friendship.status !== FriendshipStatus.Pending) {
          throw new BadRequestException('This friend request is no longer pending');
        }
        break;

      case FriendshipStatus.Withdrawn:
        if (!isRequester) {
          throw new ForbiddenException('Only the sender can withdraw a friend request');
        }
        if (friendship.status !== FriendshipStatus.Pending) {
          throw new BadRequestException('This friend request is no longer pending');
        }
        break;

      case FriendshipStatus.Blocked:
        if (friendship.status === FriendshipStatus.Blocked) {
          throw new BadRequestException('This relationship is already blocked');
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
      throw new ForbiddenException('You cannot remove a relationship that has blocked you');
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
        include: this.participantInclude,
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
      throw new NotFoundException(`Friendship with id ${id} not found`);
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
      return new ForbiddenException("You don't have permission to modify this friendship");
    }

    return error instanceof Error ? error : new Error(String(error));
  }
}
