import {
  Action,
  blockWith,
  DatabaseService,
  gameShareSnapshot,
  householdGameShareSubject,
  HUMAN_USER_WHERE,
  isPrismaDependentRecordNotFoundError,
  isPrismaForeignKeyConstraintError,
  isPrismaUniqueConstraintError,
  lockLiveHousehold,
  Prisma,
  ResourceType,
  type GameShare,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import { PaginationQueryDto, type PaginatedRows } from '@bge/shared';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CreateGameShareDto } from './dto';
import { GameShareCreatedEvent, GameShareDeletedEvent } from './game-share.events';

/**
 * Each member's user id and household role: what the household share grants'
 * role clause reads off an instance. The whole roster, as the household
 * invite routes ask about it: a roster cut down to the caller's own row
 * answers today's `some` clause the same, but would pass a `none` or `every`
 * clause it should refuse.
 */
const ROSTER_ROLE_SELECT = {
  userId: true,
  role: { select: { role: { select: { name: true } } } },
} as const satisfies Prisma.HouseholdMemberSelect;

type RosterRow = Prisma.HouseholdMemberGetPayload<{ select: typeof ROSTER_ROLE_SELECT }>;

/**
 * What the household share grants read off a household, beside the share: its
 * roster with each member's household role, and its member share policy, in
 * one query.
 */
const SHARE_AUTHORITY_SELECT = {
  settings: { select: { memberSharePolicy: true } },
  members: { select: ROSTER_ROLE_SELECT },
} as const satisfies Prisma.HouseholdSelect;

type ShareAuthority = Prisma.HouseholdGetPayload<{ select: typeof SHARE_AUTHORITY_SELECT }>;

/** The game a share is made of, as the share grants read it. */
const SHARED_GAME_SELECT = { id: true, deletedAt: true, createdById: true } as const satisfies Prisma.GameSelect;

type SharedGame = Prisma.GameGetPayload<{ select: typeof SHARED_GAME_SELECT }>;

/**
 * Who the request names, once exactly one of the two fields is known to be
 * there: `kind` says which, and the other column is null, as the share's row
 * stores it.
 */
type RecipientRequest =
  | { readonly kind: 'user'; readonly userId: string; readonly householdId: null }
  | { readonly kind: 'household'; readonly userId: null; readonly householdId: string };

/**
 * Shares a game with a named user or a household, lists a game's shares, and
 * removes one (#810). A share shows the game to its recipient on top of its
 * reach, once it is in effect, which `approvedAt` marks. The catalog decides
 * who may share, list and remove, and for a household share, from the
 * household's member share policy, whether it takes effect at once or waits
 * for approval; approving one is the household's route.
 */
@Injectable()
export class GameShareService {
  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
    private readonly scopeComposer: ScopeComposer,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Shares the game with one user or one household, in one transaction:
   *
   * 1. The game is read as a live game the acting user created. The Owner
   *    holds `manage:all`, which passes every question below, so this read is
   *    what refuses them someone else's game, a deleted one, or the server's
   *    own imported one. A live game someone else created answers 403, and no
   *    live game by that id answers 404.
   * 2. To a user: the recipient must be a registered user, or 404, and not the
   *    acting user, or 400. A block between the two, whichever placed it,
   *    refuses it with 403. Then `create` is asked of a share naming no
   *    household, and it takes effect at once.
   * 3. To a household, as an invite into one is opened
   *    (`HouseholdInviteService.createInvite`): the acting user must be on its
   *    roster, or 404, which is also what refuses the Owner a household they
   *    have no seat in. `create` is asked before the lock, so a caller with no
   *    say here is refused without holding the household's row. The row is
   *    then share-locked, or 404 once the household is gone, and the question
   *    is asked again of the roster and policy read under the lock. That
   *    answer decides whether the share takes effect at once or waits
   *    ({@link approvalUnder}).
   * 4. The insert. A second share to the same recipient is the unique index's,
   *    and answers 409. A user whose account was deleted since it was read
   *    fails the foreign key, and answers 404.
   *
   * The created share is announced after commit.
   */
  async create(gameId: string, dto: CreateGameShareDto): Promise<GameShare> {
    const sharerId = this.abilityService.getActingUserId();
    const recipient = this.recipientRequestOf(dto);
    // A share in effect from the start is approved as it is made, so the two
    // columns carry one instant.
    const now = new Date();

    let share: GameShare;
    try {
      share = await this.db.$transaction(async (tx) => {
        const game = await tx.game.findFirst({
          where: { id: gameId, deletedAt: null, createdById: sharerId },
          select: SHARED_GAME_SELECT,
        });

        if (game === null) {
          // Asked only once the read finds nothing, as the game's update asks:
          // a live game by that id is someone else's.
          if ((await tx.game.count({ where: { id: gameId, deletedAt: null } })) > 0) {
            throw new ForbiddenException(t('errors.game_share.not_owner', { gameId }));
          }

          throw new NotFoundException(t('errors.game.not_found', { id: gameId }));
        }

        const approvedAt =
          recipient.kind === 'user'
            ? await this.approvalForUserShare(tx, game, sharerId, recipient.userId, now)
            : await this.approvalForHouseholdShare(tx, game, sharerId, recipient.householdId, now);

        return tx.gameShare.create({
          data: {
            gameId,
            userId: recipient.userId,
            householdId: recipient.householdId,
            sharedById: sharerId,
            approvedAt,
            createdAt: now,
          },
        });
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        throw new ConflictException(t('errors.game_share.already_shared', { gameId }));
      }

      // The recipient is read without a lock, and staff can delete an account,
      // so one deleted between that read and the insert fails the insert's
      // foreign key. It is the same not found an id no account has answers.
      if (recipient.kind === 'user' && isPrismaForeignKeyConstraintError(error)) {
        throw new NotFoundException(t('errors.user.not_found', { id: recipient.userId }));
      }

      throw error;
    }

    this.eventEmitter.emit(GameShareCreatedEvent.eventName, new GameShareCreatedEvent(gameShareSnapshot(share), now));

    return share;
  }

  /**
   * One page of the game's shares, newest first. The scope is the game's
   * shares, and the ceiling clips it: the game's owner sees them all, waiting
   * ones included, and a household's owners and admins see the share into
   * their household. Staff, through `read:public_content`, and the Owner,
   * through `manage:all`, read every share, so they see them all too. Anyone
   * else gets an empty page. Rows and count share a
   * REPEATABLE READ transaction, so `total` describes the rows served (#230).
   * `id` breaks ties on `createdAt`, so a row cannot cross a page boundary
   * between two requests.
   */
  async listForGame(gameId: string, pagination: PaginationQueryDto): Promise<PaginatedRows<GameShare>> {
    const where = this.scopeComposer.compose(ResourceType.GameShare, Action.read, { gameId });

    const [rows, total] = await this.db.$transaction(
      [
        this.db.gameShare.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: pagination.skip,
          take: pagination.pageSize,
        }),

        this.db.gameShare.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows, total };
  }

  /**
   * Removes one of the game's shares, in one transaction, as a household
   * invite is revoked (`HouseholdInviteService.revokeInvite`):
   *
   * 1. The share is read as one of THIS game's, or the answer is 404.
   * 2. `delete` is asked of it: its sharer removes it, and a household's
   *    owners and admins remove a share into their household, whoever made
   *    it. A share to a user names no household and needs no lock.
   * 3. For a share into a household, the sharer is asked about first, of the
   *    share alone. Their grant reads no roster, so no demotion can change the
   *    answer and no lock is taken, and it holds while the household is
   *    deleted (#810): the sharer keeps the say over their own share, which a
   *    restore (#175) would otherwise put back in effect. Anyone else is asked
   *    of the roster before the lock, the household row is share-locked, or
   *    404 once the household is gone, and asked again of the roster read
   *    under the lock, so no demotion lands between that answer and the
   *    delete.
   * 4. The delete. A share someone else removed since the read answers 404.
   *
   * The removed share is announced after commit.
   */
  async delete(gameId: string, shareId: string): Promise<void> {
    const initiatedAt = new Date();

    let removed: GameShare;
    try {
      removed = await this.db.$transaction(async (tx) => {
        const share = await tx.gameShare.findFirst({ where: { id: shareId, gameId } });

        if (share === null) {
          throw new NotFoundException(t('errors.game_share.not_found', { id: shareId, gameId }));
        }

        if (share.householdId === null) {
          this.abilityService.assertCurrentActorCan(Action.delete, ResourceType.GameShare, {
            id: share.id,
            sharedById: share.sharedById,
            householdId: null,
          });
        } else if (
          // The sharer's own grant, asked without the roster, so the household
          // authority's grant cannot pass it and nothing here needs the lock.
          !this.abilityService.currentActorCan(Action.delete, ResourceType.GameShare, {
            id: share.id,
            sharedById: share.sharedById,
            householdId: share.householdId,
          })
        ) {
          await this.assertMayRemoveFromHousehold(tx, share, share.householdId);

          if (!(await lockLiveHousehold(tx, share.householdId))) {
            throw new NotFoundException(t('errors.household.not_found', { id: share.householdId }));
          }

          await this.assertMayRemoveFromHousehold(tx, share, share.householdId);
        }

        return tx.gameShare.delete({ where: { id: share.id } });
      });
    } catch (error) {
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new NotFoundException(t('errors.game_share.not_found', { id: shareId, gameId }));
      }

      throw error;
    }

    this.eventEmitter.emit(
      GameShareDeletedEvent.eventName,
      new GameShareDeletedEvent(gameShareSnapshot(removed), initiatedAt),
    );
  }

  /**
   * Exactly one of the two fields names the recipient. A JSON `null` counts as
   * absent: the DTO's `@IsOptional` lets it through, and it names nobody.
   */
  private recipientRequestOf(dto: CreateGameShareDto): RecipientRequest {
    const userId = dto.userId ?? null;
    const householdId = dto.householdId ?? null;

    if (userId !== null && householdId === null) {
      return { kind: 'user', userId, householdId };
    }

    if (householdId !== null && userId === null) {
      return { kind: 'household', userId, householdId };
    }

    throw new BadRequestException(t('errors.game_share.recipient_exactly_one'));
  }

  /**
   * The share's `approvedAt` once the acting user may share the game with this
   * user: now, since a share to a user takes effect at once. Refuses when they
   * may not.
   *
   * The recipient must be a registered user. The server's service account
   * can't sign in, and an anonymous user's account is deleted when they
   * register, which the share's cascade would follow; either is not found, as
   * an id no account has is. A block is read through `blockWith`, the read
   * rule's own definition, so the create refuses exactly the shares the rule
   * would veto.
   */
  private async approvalForUserShare(
    tx: Prisma.TransactionClient,
    game: SharedGame,
    sharerId: string,
    userId: string,
    now: Date,
  ): Promise<Date> {
    const user = await tx.user.findUnique({ where: { id: userId, ...HUMAN_USER_WHERE }, select: { id: true } });

    if (user === null) {
      throw new NotFoundException(t('errors.user.not_found', { id: userId }));
    }

    if (user.id === sharerId) {
      throw new BadRequestException(t('errors.game_share.self_share'));
    }

    if ((await tx.user.count({ where: { id: user.id, ...blockWith(sharerId) } })) > 0) {
      throw new ForbiddenException(t('errors.game_share.recipient_refused'));
    }

    this.abilityService.assertCurrentActorCan(Action.create, ResourceType.GameShare, {
      householdId: null,
      userId: user.id,
      game: { deletedAt: game.deletedAt, createdById: game.createdById },
    });

    return now;
  }

  /**
   * The share's `approvedAt` once the acting user may share the game into this
   * household: asked before the lock, then decided by the answer under it.
   * Refuses when they may not. A missing household reads as an empty roster,
   * and the acting user's absence from the roster answers 404 before anything
   * is asked, as it does once the household is gone.
   */
  private async approvalForHouseholdShare(
    tx: Prisma.TransactionClient,
    game: SharedGame,
    sharerId: string,
    householdId: string,
    now: Date,
  ): Promise<Date | null> {
    this.approvalUnder(await this.shareAuthorityOf(tx, householdId, sharerId), game, householdId, now);

    if (!(await lockLiveHousehold(tx, householdId))) {
      throw new NotFoundException(t('errors.household.not_found', { id: householdId }));
    }

    return this.approvalUnder(await this.shareAuthorityOf(tx, householdId, sharerId), game, householdId, now);
  }

  /**
   * The household's roster and member share policy, as `tx` reads them. The
   * acting user must be on the roster, or the answer is 404: the Owner's
   * `manage:all` passes every question the catalog can ask, so the roster is
   * what keeps them out of a household they have no seat in, and an outsider
   * learns nothing about the household from the answer.
   */
  private async shareAuthorityOf(
    tx: Prisma.TransactionClient,
    householdId: string,
    sharerId: string,
  ): Promise<ShareAuthority> {
    const household = await tx.household.findUnique({ where: { id: householdId }, select: SHARE_AUTHORITY_SELECT });

    if (household === null || !household.members.some((member) => member.userId === sharerId)) {
      throw new NotFoundException(t('errors.household.not_found', { id: householdId }));
    }

    return household;
  }

  /**
   * How a share into the household opens, as a member's invite does (#166):
   * in effect, as a household owner or admin always may and a member may
   * under `Direct`; or else waiting for approval, as a member may under
   * `NeedsApproval`. Refuses with 403 when the acting user may do neither. The
   * client never says which.
   *
   * The in-effect shape is asked first. The owner's and admin's rule and the
   * member's `Direct` rule don't read `approvedAt`, so a waiting share asked
   * first would pass them, and a share meant to take effect at once would
   * wait.
   */
  private approvalUnder(authority: ShareAuthority, game: SharedGame, householdId: string, now: Date): Date | null {
    const share = (approvedAt: Date | null) => householdGameShareSubject(householdId, approvedAt, game, authority);

    if (this.abilityService.currentActorCan(Action.create, ResourceType.GameShare, share(now))) {
      return now;
    }

    this.abilityService.assertCurrentActorCan(Action.create, ResourceType.GameShare, share(null));

    return null;
  }

  /**
   * Asks whether the acting user may remove this share from its household, of
   * the household's roster as `tx` reads it: the household's owners and
   * admins may. The sharer never gets here: they are asked about first,
   * without the roster.
   */
  private async assertMayRemoveFromHousehold(
    tx: Prisma.TransactionClient,
    share: GameShare,
    householdId: string,
  ): Promise<void> {
    const members: RosterRow[] = await tx.householdMember.findMany({
      where: { householdId },
      select: ROSTER_ROLE_SELECT,
    });

    this.abilityService.assertCurrentActorCan(Action.delete, ResourceType.GameShare, {
      id: share.id,
      sharedById: share.sharedById,
      householdId,
      household: { members },
    });
  }
}
