import type { GameSummary, Prisma } from '@bge/database';
import {
  Action,
  DatabaseService,
  GAME_SUMMARY_SELECT,
  isPrismaForeignKeyConstraintError,
  ResourceType,
} from '@bge/database';
import { CodedHttpException, t } from '@bge/i18n';
import { AbilityService, resolveScopeSubjectId, ScopeComposer } from '@bge/permissions';
import { WebhookEventType } from '@bge/webhooks';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Http } from '@status/codes';
import { ExcludeGameDto, UpdateCollectionSharingDto } from '../dto';
import { HouseholdEventPublisher, householdWebhook } from '../events/household-event.publisher';
import {
  HouseholdExcludedGameAddedEvent,
  HouseholdExcludedGameRemovedEvent,
  HouseholdMemberCollectionSharingChangedEvent,
} from '../events/household.events';
import { lockHouseholdForRoleTransition } from '../household-access.helpers';
import { MEMBER_SELECT } from '../read-shapes';
import type { HouseholdMemberWithRelations } from './household-member.service';

/** An excluded game as the routes read it (#170). */
export const EXCLUDED_GAME_SELECT = {
  gameCollectionId: true,
  excludedReason: true,
  excludedAt: true,
  gameCollection: {
    select: {
      platformGame: {
        select: {
          id: true,
          game: { select: GAME_SUMMARY_SELECT },
        },
      },
    },
  },
} as const satisfies Prisma.ExcludedGameSelect;

type ExcludedGameRow = Prisma.ExcludedGameGetPayload<{ select: typeof EXCLUDED_GAME_SELECT }>;

/**
 * One of the caller's excluded games, as the routes return it (#170). The
 * reason is the caller's own note, so it is returned to them here and nowhere
 * else: no event or webhook carries it.
 */
export interface ExcludedGameView {
  readonly collectionEntryId: string;
  readonly excludedAt: Date;

  readonly platformGame: {
    readonly game: GameSummary;
    readonly id: string;
  };

  readonly reason: string | null;
}

/** The ids of the caller's own membership, which every route here acts on. */
const OWN_MEMBERSHIP_SELECT = {
  id: true,
  householdId: true,
  userId: true,
} as const satisfies Prisma.HouseholdMemberSelect;

type MembershipAction = typeof Action.read | typeof Action.update;

function toExcludedGameView(row: ExcludedGameRow): ExcludedGameView {
  return {
    collectionEntryId: row.gameCollectionId,
    reason: row.excludedReason,
    excludedAt: row.excludedAt,
    platformGame: row.gameCollection.platformGame,
  };
}

/**
 * The refusal for an entry that isn't one of the caller's live collection
 * entries: missing, removed, or another member's, which the 404 never tells
 * apart (#170). It carries the collection's own code (#634), since it says the
 * same thing about the same row.
 */
function collectionEntryNotFound(): CodedHttpException {
  return new CodedHttpException(
    Http.NotFound,
    'COLLECTION_ENTRY_NOT_FOUND',
    t('errors.household.collection_entry_not_found'),
  );
}

/** The refusal for putting back a game the caller hasn't excluded from this household (#170). */
function excludedGameNotFound(): CodedHttpException {
  return new CodedHttpException(
    Http.NotFound,
    'EXCLUDED_GAME_NOT_FOUND',
    t('errors.household.excluded_game_not_found'),
  );
}

/**
 * A member's own say over how their games join a household's game pool: their
 * collection sharing and their excluded games (#170).
 *
 * Every route acts on the caller's own membership, and only theirs. A household
 * owner's `manage` on `HouseholdMember` implies `update` on every member of the
 * household, and a household admin's on every member and guest, so the
 * ceiling alone would match whichever row came first. The lookup pins
 * `userId` to the caller, which makes "me" mean me however broad the grants
 * are, as leaving the household does (#157).
 *
 * Each change publishes after commit, and only a change publishes: the domain
 * event, which the audit persistence listener records, carrying ids only. A
 * change to collection sharing also sends a webhook to whoever can read the
 * household, as every roster read already shows the flag. An excluded game
 * sends none: that audience includes fellow members and, by the household's
 * reach, friends of members, and the roster read keeps excluded games from all
 * of them (#868). An excluded game's reason never leaves the server.
 */
@Injectable()
export class CollectionSharingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
    private readonly scopeComposer: ScopeComposer,
    private readonly publisher: HouseholdEventPublisher,
  ) {}

  /**
   * Turns the caller's collection sharing with this household on or off
   * (#170), and returns their roster row.
   *
   * One transaction reads the value it replaces and writes the new one. The
   * write is conditional on the value differing, so of two toggles racing,
   * only the one that changed it publishes the change: the second waits on
   * the first's row lock, then finds nothing left to change.
   */
  async setCollectionSharing(
    householdId: string,
    dto: UpdateCollectionSharingDto,
  ): Promise<HouseholdMemberWithRelations> {
    const initiatedAt = new Date();
    const userId = resolveScopeSubjectId(this.abilityService);
    const { collectionSharing } = dto;

    const { changed, member } = await this.db.$transaction(async (tx) => {
      const own = await this.findOwnMembership(tx, householdId, userId, Action.update, MEMBER_SELECT);

      const { count } = await tx.householdMember.updateMany({
        where: { id: own.id, collectionSharing: !collectionSharing },
        data: { collectionSharing },
      });

      const member = await tx.householdMember.findUnique({ where: { id: own.id }, select: MEMBER_SELECT });

      // Removed while this waited on the row lock.
      if (!member) {
        throw this.notAMember(householdId);
      }

      return { changed: count > 0, member };
    });

    if (changed) {
      const membership = { householdId, memberId: member.id, userId: member.userId };

      this.publisher.publish(
        new HouseholdMemberCollectionSharingChangedEvent(
          { ...membership, collectionSharing: !collectionSharing },
          { ...membership, collectionSharing },
          initiatedAt,
        ),
        householdWebhook(WebhookEventType.HouseholdMemberCollectionSharingChanged, membership),
      );
    }

    return member;
  }

  /**
   * The caller's own excluded games for this household (#170), newest first,
   * of the collection entries they still hold. Not paged: it is bounded by the
   * caller's own collection.
   *
   * An excluded game of a removed entry is kept, so it comes back if the entry
   * is added again, but it isn't listed while the entry is gone.
   */
  async listExcludedGames(householdId: string): Promise<ExcludedGameView[]> {
    const userId = resolveScopeSubjectId(this.abilityService);
    const own = await this.findOwnMembership(this.db, householdId, userId, Action.read, OWN_MEMBERSHIP_SELECT);

    const rows = await this.db.excludedGame.findMany({
      where: { householdMemberId: own.id, gameCollection: { userId, deletedAt: null } },
      orderBy: [{ excludedAt: 'desc' }, { id: 'desc' }],
      select: EXCLUDED_GAME_SELECT,
    });

    return rows.map(toExcludedGameView);
  }

  /**
   * Holds one of the caller's collection entries back from this household's
   * game pool (#170). Recorded against the caller's own membership, and only
   * for the caller's own live entry: another member's entry, whose id every
   * game pool read hands out, answers the same 404 as a missing one and
   * writes nothing.
   *
   * Idempotent: a repeat replaces the reason and keeps when it was first
   * excluded. The insert skips a duplicate rather than failing on it, so its
   * count says whether this call created the excluded game, and only a create
   * publishes, even when two calls race.
   *
   * The insert waits on the household's role-transition lock, which leaving,
   * removal and a ban take before they clear the member's excluded games and
   * delete the membership. Without it, an insert that commits between those
   * two deletes leaves a row the membership's foreign key refuses, and the
   * leave answers 500. Under the lock, a leave that went first ends the
   * membership and this insert answers the membership 404; an insert that
   * went first is cleared by the leave that follows. The lock comes after the
   * membership and entry reads, so a 403 or 404 takes no lock, as on the
   * leave path.
   */
  async excludeGame(householdId: string, dto: ExcludeGameDto): Promise<ExcludedGameView> {
    const initiatedAt = new Date();
    const userId = resolveScopeSubjectId(this.abilityService);
    const excludedReason = dto.reason ?? null;

    const { created, own, row } = await this.db.$transaction(async (tx) => {
      const own = await this.findOwnMembership(tx, householdId, userId, Action.update, OWN_MEMBERSHIP_SELECT);

      const entry = await tx.gameCollection.findFirst({
        where: { id: dto.collectionEntryId, userId, deletedAt: null },
        select: { id: true },
      });

      if (!entry) {
        throw collectionEntryNotFound();
      }

      await lockHouseholdForRoleTransition(tx, householdId);

      const key = { householdMemberId: own.id, gameCollectionId: entry.id };
      const created = await this.writeExcludedGame(tx, householdId, { ...key, excludedReason });

      const row = await tx.excludedGame.findUniqueOrThrow({
        where: { householdMemberId_gameCollectionId: key },
        select: EXCLUDED_GAME_SELECT,
      });

      return { created, own, row };
    });

    if (created) {
      const excluded = {
        householdId,
        memberId: own.id,
        userId: own.userId,
        collectionEntryId: row.gameCollectionId,
      };

      this.publisher.publish(new HouseholdExcludedGameAddedEvent(excluded, initiatedAt));
    }

    return toExcludedGameView(row);
  }

  /**
   * Puts an excluded game back into this household's game pool (#170). 404
   * when the caller hasn't excluded it, which a second of two racing calls
   * hears too.
   *
   * It matches what the list shows: an excluded game of a removed entry
   * answers the same 404, and stays until the entry is added again, as it
   * does for every other route.
   */
  async removeExcludedGame(householdId: string, collectionEntryId: string): Promise<void> {
    const initiatedAt = new Date();
    const userId = resolveScopeSubjectId(this.abilityService);

    const own = await this.db.$transaction(async (tx) => {
      const own = await this.findOwnMembership(tx, householdId, userId, Action.update, OWN_MEMBERSHIP_SELECT);

      const { count } = await tx.excludedGame.deleteMany({
        where: {
          householdMemberId: own.id,
          gameCollectionId: collectionEntryId,
          gameCollection: { userId, deletedAt: null },
        },
      });

      if (count === 0) {
        throw excludedGameNotFound();
      }

      return own;
    });

    const excluded = { householdId, memberId: own.id, userId: own.userId, collectionEntryId };

    this.publisher.publish(new HouseholdExcludedGameRemovedEvent(excluded, initiatedAt));
  }

  /**
   * The caller's own membership of a live household, under the caller's
   * `action` scope on `HouseholdMember`, with `userId` pinned in the where.
   *
   * A miss is a 404 when the caller has no membership here, and a 403 when
   * they have one their grant doesn't reach: an API key scoped to another
   * household passes the route's type-level gate.
   */
  private async findOwnMembership<TSelect extends Prisma.HouseholdMemberSelect>(
    client: DatabaseService | Prisma.TransactionClient,
    householdId: string,
    userId: string,
    action: MembershipAction,
    select: TSelect,
  ): Promise<Prisma.HouseholdMemberGetPayload<{ select: TSelect }>> {
    const own = { householdId, userId, household: { deletedAt: null } } satisfies Prisma.HouseholdMemberWhereInput;

    const member = await client.householdMember.findFirst({
      where: this.scopeComposer.compose(ResourceType.HouseholdMember, action, own),
      select,
    });

    if (member) {
      return member;
    }

    if ((await client.householdMember.count({ where: own })) > 0) {
      throw new ForbiddenException(t(action === Action.read ? 'common.forbidden.view' : 'common.forbidden.update'));
    }

    throw this.notAMember(householdId);
  }

  /**
   * Writes the excluded game, and says whether this call created it (#170).
   *
   * The insert skips a duplicate; the reason is then replaced on the row it
   * skipped. A racing include can delete that row in between, so a replace
   * that matches nothing inserts once more, and that insert is a create. Should
   * a third call re-create the row before it, the row stands as that call
   * wrote it, and this call published nothing.
   */
  private async writeExcludedGame(
    tx: Prisma.TransactionClient,
    householdId: string,
    data: Prisma.ExcludedGameCreateManyInput,
  ): Promise<boolean> {
    if (await this.insertExcludedGame(tx, householdId, data)) {
      return true;
    }

    const { count } = await tx.excludedGame.updateMany({
      where: { householdMemberId: data.householdMemberId, gameCollectionId: data.gameCollectionId },
      data: { excludedReason: data.excludedReason },
    });

    if (count > 0) {
      return false;
    }

    return this.insertExcludedGame(tx, householdId, data);
  }

  /**
   * Inserts the excluded game unless it exists, and says whether it did. A
   * foreign key that fails means a row read earlier in the call is gone: the
   * membership left, or the entry was deleted, mid-call. Both answer 404,
   * rather than a 500, and the one membership 404 answers either, as every
   * other foreign key failure in the repo maps to a single 404.
   */
  private async insertExcludedGame(
    tx: Prisma.TransactionClient,
    householdId: string,
    data: Prisma.ExcludedGameCreateManyInput,
  ): Promise<boolean> {
    try {
      const { count } = await tx.excludedGame.createMany({ data: [data], skipDuplicates: true });

      return count > 0;
    } catch (error) {
      if (!isPrismaForeignKeyConstraintError(error)) {
        throw error;
      }

      throw this.notAMember(householdId);
    }
  }

  private notAMember(householdId: string): NotFoundException {
    return new NotFoundException(t('errors.household.not_a_member', { householdId }));
  }
}
