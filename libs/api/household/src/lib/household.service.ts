import { changedKeys, pickSnapshot } from '@bge/actor-context';
import type { Household } from '@bge/database';
import {
  Action,
  createOrReplay,
  DatabaseService,
  GAME_SUMMARY_SELECT,
  HouseholdMembershipOrigin,
  isPrismaDependentRecordNotFoundError,
  normalizeClientRequestId,
  Prisma,
  Reach,
  ResourceType,
  SystemRole,
} from '@bge/database';
import { CodedHttpException, t } from '@bge/i18n';
import { InviteService } from '@bge/invites';
import { canonicalizeTag } from '@bge/locale';
import {
  AbilityService,
  PermissionsService,
  resolveActingUserIdOrNull,
  resolveScopeSubjectId,
  ScopeComposer,
} from '@bge/permissions';
import { PaginatedRows, PaginationQueryDto, pickDefined, sampleWithoutReplacement } from '@bge/shared';
import { WebhookEventType } from '@bge/webhooks';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Http } from '@status/codes';
import assert from 'node:assert';
import { HOUSEHOLD_RESTORE_PERMISSION_SLUG, HOUSEHOLD_RESTORE_WINDOW_MS } from './constants/household.constants';
import type { UpdateHouseholdSettingsDto } from './dto';
import { CreateHouseholdDto, UpdateHouseholdDto } from './dto';
import { HouseholdEventPublisher, householdWebhook } from './events/household-event.publisher';
import type { HouseholdStateSnapshot } from './events/household.events';
import {
  HouseholdCreatedEvent,
  HouseholdDeletedEvent,
  HouseholdRestoredEvent,
  householdStateSnapshot,
  HouseholdUpdatedEvent,
} from './events/household.events';
import type { LockFreeReadClient } from './household-access.helpers';
import {
  assertHouseholdExists,
  householdRefusal,
  lockDeletedHousehold,
  lockHouseholdForRoleTransition,
} from './household-access.helpers';
import { HOUSEHOLD_SETTINGS_SELECT, MEMBER_SELECT } from './read-shapes';

/**
 * Relations returned with every household in the list read. Extracted so the
 * payload type below stays in step with what the query actually selects.
 */
const HOUSEHOLD_LIST_INCLUDE = {
  languageTag: {
    select: {
      id: true,
      tag: true,
      name: true,
    },
  },

  members: { select: MEMBER_SELECT },

  // As the detail carries them, so a client deciding whether to offer a member
  // the invite button need not read each household (#166).
  settings: { select: HOUSEHOLD_SETTINGS_SELECT },
} satisfies Prisma.HouseholdInclude;

export type HouseholdWithRelations = Prisma.HouseholdGetPayload<{ include: typeof HOUSEHOLD_LIST_INCLUDE }>;

/**
 * A deleted household as the restorable list returns it (#542): the list row,
 * plus when the acting user's restore window for it ends, or `null` when their
 * grant has no end date.
 */
export type RestorableHousehold = HouseholdWithRelations & { readonly restorableUntil: Date | null };

/**
 * The rows of one page of a household list: the list include, the order, and
 * the page window. Each list counts over the same `where`, in the same
 * snapshot as its rows.
 *
 * The order is total: `createdAt` alone would let rows created in the same
 * transaction share a key and drift across page boundaries between requests —
 * page 2 re-showing a row page 1 already had, and dropping another.
 */
function householdPageArgs(where: Prisma.HouseholdWhereInput, pagination: PaginationQueryDto) {
  return {
    where,
    include: HOUSEHOLD_LIST_INCLUDE,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: pagination.skip,
    take: pagination.pageSize,
  } satisfies Prisma.HouseholdFindManyArgs;
}

/** How many of each member's entries the household detail embeds. */
const MEMBER_GAME_SAMPLE_SIZE = 5;

/**
 * What a soft delete returns: the tombstoned row, and when the actor's window
 * to restore it ends, or `null` when the delete opened none for them (#175).
 */
export interface HouseholdDeletion {
  readonly household: Household;
  readonly restorableUntil: Date | null;
}

/**
 * What a delete's recovery grants opened (#175): when the acting owner's
 * restore window ends, or `null` when the delete opened none for them, and the
 * users it gave a restore window, by user id, which its domain event records
 * (#245).
 */
interface RecoveryGrants {
  readonly restorableUntil: Date | null;
  readonly windowUserIds: string[];
}

/**
 * The columns of {@link HouseholdStateSnapshot} an edit can change, which is
 * every one but `id`: the update diffs these (#245). A record rather than a
 * list, so a column added to the snapshot and not here fails to compile
 * instead of going unrecorded.
 */
const HOUSEHOLD_EDITABLE_COLUMNS: { readonly [Column in Exclude<keyof HouseholdStateSnapshot, 'id'>]: Column } = {
  name: 'name',
  description: 'description',
  image: 'image',
  reach: 'reach',
  languageTagId: 'languageTagId',
  memberInvitePolicy: 'memberInvitePolicy',
  memberSharePolicy: 'memberSharePolicy',
  gamePoolReach: 'gamePoolReach',
};

/**
 * The settings an edit writes, with the game pool reach kept within the
 * household's reach once the edit lands (#367). A friend who can't see the
 * household can't see its game pool either, so:
 *
 * - a patch that sets the game pool reach to `Friends` while the household is,
 *   or becomes, `Private` is refused with a 400 naming what to change first;
 * - a patch that narrows the household to `Private` and leaves the game pool
 *   reach out lowers a stored `Friends` to `Private` in the same write, so the
 *   game pool never reaches further than the household it belongs to.
 *
 * Lowered rather than refused: narrowing a household is the stronger privacy
 * choice, and refusing it until the owner also changed a second setting would
 * keep the household wider than they asked for.
 */
function settingsWithinHouseholdReach(
  settings: Partial<UpdateHouseholdSettingsDto>,
  householdReach: Reach,
  stored: { readonly gamePoolReach: Reach } | null,
): Partial<UpdateHouseholdSettingsDto> {
  if (householdReach !== Reach.Private) {
    return settings;
  }

  if (settings.gamePoolReach === Reach.Friends) {
    throw new CodedHttpException(
      Http.BadRequest,
      'GAME_POOL_REACH_WIDER_THAN_HOUSEHOLD',
      t('errors.household.game_pool_reach_wider_than_household'),
    );
  }

  if (settings.gamePoolReach === undefined && stored?.gamePoolReach === Reach.Friends) {
    return { ...settings, gamePoolReach: Reach.Private };
  }

  return settings;
}

@Injectable()
export class HouseholdService {
  private readonly logger = new Logger(HouseholdService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
    private readonly permissions: PermissionsService,
    private readonly scopeComposer: ScopeComposer,
    private readonly invites: InviteService,
    private readonly publisher: HouseholdEventPublisher,
  ) {}

  /**
   * The household, with its roster and settings. It embeds no invites (#665):
   * this read reaches every reader of the household, a member's friends
   * included, and a read on its invites belongs to the household's owners and
   * admins, and to staff. They list them at
   * `GET /households/:householdId/invites`, and an inviter finds their own at
   * `GET /invites/sent`.
   */
  async getHouseholdById(id: string) {
    const household = await this.db.household.findUnique({
      where: {
        id,
        deletedAt: null,
        // eslint-disable-next-line no-restricted-syntax -- single-row fetch by id, not a collection read
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.Household, Action.read),
      },
      include: {
        languageTag: {
          select: {
            id: true,
            tag: true,
            name: true,
          },
        },

        // To every reader of the household (#166): a member's client reads the
        // member invite and share policies here to know whether to offer an
        // invite or a share (#810).
        settings: { select: HOUSEHOLD_SETTINGS_SELECT },

        // The roster surface and nothing else. Every reader of the household
        // gets this response, guests and a member's friends too, so a
        // member's excluded games are filtered out of their sample in its own
        // read, never selected here (#868).
        members: { select: MEMBER_SELECT },
      },
    });

    if (!household) {
      // The scoped read matched nothing: probe existence to distinguish a
      // missing household (404) from one that exists but isn't visible (403).
      throw await householdRefusal(this.db, id, t('common.forbidden.view'));
    }

    const memberGamesPromises = household.members.map((member) => this.getSelectMemberGames(member.userId, member.id));

    const memberGames = await Promise.all(memberGamesPromises);
    const memberGamesMap = memberGames.reduce<
      Record<string, { id: string; platformGame: { game: { id: string; title: string }; id: string } }[]>
    >(
      (acc, { memberId, gameCollections }) => ({
        ...acc,
        [memberId]: gameCollections,
      }),
      {},
    );

    const members = household.members.map((member) => ({
      ...member,
      user: {
        ...member.user,
        gameCollections: memberGamesMap[member.userId] || [],
      },
    }));

    return {
      ...household,
      members,
    };
  }

  /**
   * Up to five of a member's collection entries, sampled at random from those
   * the viewer may read.
   *
   * Both reads compose the `GameCollection` read ceiling, top-level, so the
   * sample can never show an entry the viewer could not read by id (#514).
   * Before, the sample was raw SQL over `game_collections` that filtered only
   * the owner and the tombstone, and served members' Private entries.
   *
   * The ids are sampled in memory rather than with `ORDER BY random()`: the
   * ceiling is a Prisma where clause, and restating it in SQL would copy the
   * catalog's rule by hand. Only ids are loaded for the whole visible set, and
   * the full shape only for the five sampled.
   *
   * The games the member excluded from this household sit beside the
   * composed clause, as a filter on the entry's `ExcludedGame` rows for this
   * membership, so the roster read never has to carry them (#868). The
   * ceiling's household rule approximates `collectionSharing` and excluded games
   * across every household the owner and viewer share, not just this one; the
   * exact rule for a single household belongs to the collection pool read
   * (#367).
   */
  private async getSelectMemberGames(memberId: string, householdMemberId: string) {
    // One where for both reads: the member's live entries under the ceiling,
    // the games they excluded from this household beside it. The second read
    // narrows it to the sample, so an entry deleted or made Private between
    // the two reads is not served from it.
    const memberEntriesWhere = (sampled?: string[]) => ({
      AND: [
        this.scopeComposer.compose(ResourceType.GameCollection, Action.read, {
          userId: memberId,
          deletedAt: null,
          ...(sampled ? { id: { in: sampled } } : {}),
        }),
        { excludedFromHouseholds: { none: { householdMemberId } } },
      ],
    });

    const visible = await this.db.gameCollection.findMany({ where: memberEntriesWhere(), select: { id: true } });

    const sampledIds = sampleWithoutReplacement(
      visible.map((row) => row.id),
      MEMBER_GAME_SAMPLE_SIZE,
    );
    if (sampledIds.length === 0) {
      return { gameCollections: [], memberId };
    }

    const gameCollections = await this.db.gameCollection.findMany({
      where: memberEntriesWhere(sampledIds),
      select: {
        id: true,
        platformGame: {
          select: {
            id: true,

            game: { select: GAME_SUMMARY_SELECT },
          },
        },
      },
    });

    return {
      gameCollections,
      memberId,
    };
  }

  /**
   * Resolves a client-supplied BCP 47 tag to the LanguageTag row id.
   * 400 on syntactically invalid tags and on tags outside the vocabulary.
   */
  private async resolveLanguageTagId(tag: string | undefined): Promise<string | undefined> {
    if (tag === undefined) {
      return undefined;
    }

    const canonical = canonicalizeTag(tag);
    assert(canonical, new BadRequestException(t('errors.household.invalid_language_tag', { tag })));

    const languageTag = await this.db.languageTag.findUnique({
      where: { tag: canonical },
      select: { id: true },
    });
    assert(languageTag, new BadRequestException(t('errors.household.language_tag_unsupported', { tag: canonical })));

    return languageTag.id;
  }

  /**
   * Creates a household with the acting user as its owner.
   *
   * Keyed by `clientRequestId` (#210) through `createOrReplay` (#252): a
   * repeat under a key this user already used returns the ORIGINAL household,
   * even one soft-deleted since, rather than creating a second. The lookup
   * runs before the language tag resolves, so a tag the server has stopped
   * supporting can't refuse the retry of a create that succeeded.
   *
   * A fresh create is published after it commits (#245): the household
   * created domain event, which its audit entry records. No webhook, since no
   * subscription can name a household before it exists.
   */
  async create(createHouseholdDto: CreateHouseholdDto) {
    const initiatedAt = new Date();
    const userId = this.abilityService.getActingUserId();
    const { language, clientRequestId: rawClientRequestId, ...rest } = createHouseholdDto;
    const clientRequestId = normalizeClientRequestId(rawClientRequestId);

    const { row: household, replayed } = await createOrReplay({
      clientRequestId,
      // No `deletedAt: null` filter: the keyed create semantically succeeded,
      // and that row, even if since soft-deleted, is its canonical outcome for
      // the client to reconcile against.
      find: (key) =>
        this.db.household.findUnique({
          where: { createdById_clientRequestId: { createdById: userId, clientRequestId: key } },
        }),
      logger: this.logger,
      label: 'household create',
      create: async () => {
        const languageTagId = await this.resolveLanguageTagId(language);

        return this.db.household.create({
          data: {
            ...rest,
            clientRequestId,
            languageTag: languageTagId
              ? {
                  connect: {
                    id: languageTagId,
                  },
                }
              : undefined,

            createdBy: {
              connect: {
                id: userId,
              },
            },

            // Every household has its settings row, with each setting at its
            // default (#166). In the same statement, so no household is ever
            // without one.
            settings: { create: {} },

            members: {
              create: {
                userId,
                // Provenance (#276). The founder is the one membership that is not
                // produced by `addMemberWithin`: this create is deliberately NOT
                // inside a transaction of ours, which is what lets `createOrReplay`
                // re-read after a P2002 (Postgres aborts a transaction on
                // constraint violation, so a recovery inside one cannot re-read).
                // Routing it through the seam would force a transaction it does
                // not need and break that. It is also the only case where
                // `HouseholdOwner` is legitimate.
                //
                // Quota (#159): this row is not CHARGED — creation never consumes,
                // so a household can always be created regardless of the cap — but
                // it IS COUNTED. `countHouseholdMembers` counts every row in the
                // household, so a cap of N is a roster cap of N with the founder
                // inside it, and the first admission through the seam already sees
                // usage of 1.
                origin: HouseholdMembershipOrigin.Founder,
                addedById: userId,
                role: {
                  create: {
                    role: {
                      connect: {
                        name: SystemRole.HouseholdOwner,
                      },
                    },
                  },
                },
              },
            },
          },
        });
      },
    });

    // The acting user just became a HouseholdOwner — evict their cached ability
    // graph so the new household-scoped grants resolve on their next request.
    //
    // A replay evicts too. Replays are usually pure no-ops, but the one
    // pathological original — committed, then crashed before its own eviction
    // ran — leaves the owner's ability graph stale; the retry is the natural
    // place to heal it, and eviction is idempotent and cheap.
    await this.permissions.invalidateUser(userId);

    // A replay emits nothing, since it created nothing: the request that
    // created the household published it (#210). A fresh create is published
    // after the eviction, so a listener acting on it finds the owner's grants.
    if (!replayed) {
      const { id, name, description, image, reach, languageTagId } = household;

      this.publisher.publish(
        new HouseholdCreatedEvent({ id, name, description, image, reach, languageTagId }, initiatedAt),
      );
    }

    return household;
  }

  /**
   * Edits the household and its settings (#166) in one scoped update, under
   * `update:household`: the owners and admins of the household.
   *
   * The settings are upserted rather than updated. Every household is created
   * with its row, and the migration that added them filled one in for the
   * rest, so the create half runs only for a row a write outside the api left
   * out. A nested update would answer that row's absence as the scoped write's
   * 403 to an owner, naming nothing that is wrong.
   *
   * The edit is recorded (#245). Its state before the write is read under the
   * household row lock role transitions take, so it is the state the write
   * replaces. After commit, the columns and settings whose values changed are
   * published, before and after, with the `household.household.updated.v1`
   * webhook naming them. A patch that re-sends stored values changes nothing,
   * so it publishes nothing (#728).
   *
   * A household with no settings row has no member invite or share policy,
   * which no invite or share grant matches. The row the upsert creates gives
   * it every setting, the ones the patch sent and the others' column defaults,
   * so each is recorded as changed. The policies' defaults change what members
   * may do, though the patch did not name them; the game pool reach's default
   * is recorded because the row now holds it, though it admits no one new.
   *
   * The game pool reach is kept within the household's reach as the edit
   * leaves it (#367): see {@link settingsWithinHouseholdReach}. A household
   * narrowed to `Private` lowers it in the same write, and that is recorded as
   * a change too.
   */
  async updateHousehold(id: string, updateHouseholdDto: UpdateHouseholdDto) {
    const initiatedAt = new Date();
    const { language, settings: rawSettings, ...rawFields } = updateHouseholdDto;
    // The household's own fields and its settings judged alike: a key sent as
    // `undefined` names nothing, in either half.
    const fields = pickDefined(rawFields);
    const settings = pickDefined(rawSettings ?? {});

    if (Object.keys(fields).length === 0 && language === undefined && Object.keys(settings).length === 0) {
      throw new BadRequestException(t('common.at_least_one_field'));
    }

    const languageTagId = await this.resolveLanguageTagId(language);

    const editable = {
      id,
      deletedAt: null,
      // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
      AND: this.abilityService.getCurrentResourceConditions(ResourceType.Household, Action.update),
    } satisfies Prisma.HouseholdWhereInput;

    try {
      const { before, household } = await this.db.$transaction(async (tx) => {
        // Permission first, as the scoped write's own where. A miss answers
        // 403, or 404 for an unknown or deleted household (see
        // `scopedWriteRefusal`), so no separate existence probe runs in front
        // of the transaction. Asked before the lock, so a caller who may not
        // edit the household never holds its row.
        if ((await tx.household.count({ where: editable })) === 0) {
          throw await this.scopedWriteRefusal(id, t('common.forbidden.update'), tx);
        }

        // Also the liveness check: a delete that committed since the count
        // leaves nothing to edit, and this answers 404.
        await lockHouseholdForRoleTransition(tx, id);

        const stored = await tx.household.findUniqueOrThrow({
          where: { id },
          include: { settings: { select: HOUSEHOLD_SETTINGS_SELECT } },
        });

        // Judged against the stored row read under the lock, so a concurrent
        // edit to the household's reach can't slip past it (#367). That holds
        // only while this transaction stays at READ COMMITTED: the read after
        // the lock is a new statement that sees a concurrent writer's commit,
        // where RepeatableRead would snapshot at the earlier count, before the
        // lock.
        const written = settingsWithinHouseholdReach(settings, fields.reach ?? stored.reach, stored.settings);

        const household = await tx.household.update({
          where: editable,
          data: {
            ...fields,
            languageTag: languageTagId
              ? {
                  connect: {
                    id: languageTagId,
                  },
                }
              : undefined,
            ...(Object.keys(written).length === 0
              ? {}
              : { settings: { upsert: { create: written, update: written } } }),
          },
          include: { settings: { select: HOUSEHOLD_SETTINGS_SELECT } },
        });

        return { before: householdStateSnapshot(stored), household };
      });

      this.publishHouseholdUpdated(before, householdStateSnapshot(household), initiatedAt);

      return household;
    } catch (error) {
      // A refusal decided inside the transaction, or the lock's 404: outcomes
      // the route is specified to produce, rethrown as they are and not logged
      // as failures. Only client errors: an `HttpException` with a 5xx status
      // is a server-side failure and still gets the error log below.
      if (error instanceof HttpException && error.getStatus() < 500) {
        throw error;
      }

      if (isPrismaDependentRecordNotFoundError(error)) {
        throw await this.scopedWriteRefusal(id, t('common.forbidden.update'));
      }

      this.logger.error(`Error updating household with id ${id}`, error);
      throw error;
    }
  }

  /**
   * Publishes a committed edit (#245): the columns whose values changed,
   * before and after, and the webhook naming them. Nothing when none did
   * (#728).
   */
  private publishHouseholdUpdated(
    before: HouseholdStateSnapshot,
    after: HouseholdStateSnapshot,
    initiatedAt: Date,
  ): void {
    const changed = changedKeys(before, after, Object.values(HOUSEHOLD_EDITABLE_COLUMNS));

    if (changed.length === 0) {
      return;
    }

    this.publisher.publish(
      new HouseholdUpdatedEvent(pickSnapshot(before, changed), pickSnapshot(after, changed), initiatedAt),
      householdWebhook(WebhookEventType.HouseholdUpdated, { householdId: after.id, changedFields: changed }),
    );
  }

  /**
   * Paginated households the caller is a member of. FIRST-PERSON: the scope is
   * the caller's own `HouseholdMember` rows, so this route answers the same
   * question for everybody (#417), applying the rule #365 settled: the path
   * names the scope. It is composed with the caller's ceiling in the one place
   * allowed to write both halves (#416):
   *
   * ```
   * rows = my memberships AND what my ability admits
   * ```
   *
   * It used to answer three. The scope WAS the permission ceiling, so a plain
   * user received their memberships, a user with friends also received those
   * friends' `Friends`-visible households, and Owner/Admin/Moderator received
   * every household on the server — one route, and the caller decided which
   * question it had asked. `pagination.total` was scoped the same way, so a
   * client could not tell the cases apart either. That is the ambiguity #365
   * was filed about, removed here at its original instance.
   *
   * Friend reach is narrowed, not withdrawn. `read:households:friends`
   * still reaches a friend's household whose reach admits friends through
   * {@link getHouseholdById}, which ANDs the ceiling exactly as before; what it
   * loses is its effect on this LIST. Reading another subject's households as a
   * list belongs on a path-parameterized route (#485), unbuilt until a consumer
   * needs it; staff list every household at `GET /admin/households` (#419),
   * through its own controller.
   *
   * Three constraints carry the guarantee (#364), and each is asserted rather
   * than left to the shape of this query:
   *
   * - The membership clause is the scope. The ability conditions
   *   alone would readmit friends' `Friends`-visible households, which the
   *   caller is not a member of — and for staff, every household on the
   *   server.
   * - It is ANDed with those conditions, never a substitute for them. For an
   *   `apiKey` actor the conditions carry the key ∩ owner
   *   floor, so dropping them would widen a narrow key to the owner's full
   *   membership list. Routing both halves through the composer is what makes
   *   dropping them unrepresentable rather than merely discouraged.
   * - `deletedAt: null` stays. `deleteHousehold` retains member rows
   *   by design, so the membership clause still matches a soft-deleted
   *   household.
   *
   * `HouseholdMember` has no `deletedAt` — removal is a hard delete — so for a
   * user session this scope leaves a row's absence meaning exactly "removed or
   * deleted". For an API key it does not: the ANDed conditions carry the
   * key ∩ owner floor, so absence also means "outside this key's scope". That
   * is the intended trade — a widened key would be the worse bug. What a
   * client may conclude from absence, including how pagination limits it, is
   * the route's contract and is stated once, in its OpenAPI description.
   *
   * `resolveScopeSubjectId` refuses `plugin`, `system` and `external` actors
   * (#417): "my households" has no meaning for an actor with no user, and
   * the refusal must never soften into an empty page, which would tell a client
   * its memberships were removed. PROVISIONAL — #395.
   */
  async getHouseholdsForUser(pagination: PaginationQueryDto): Promise<PaginatedRows<HouseholdWithRelations>> {
    const userId = resolveScopeSubjectId(this.abilityService);

    return this.paginateHouseholds(
      this.scopeComposer.compose(ResourceType.Household, Action.read, {
        deletedAt: null,
        members: { some: { userId } },
      }),
      pagination,
    );
  }

  /**
   * One page of the deleted households the acting user can restore (#542),
   * each with when their restore window ends. It is how a household owner
   * finds the undo `DELETE` offered again, from another device or after the
   * response was lost.
   *
   * The set is the acting user's grants of the restore permission, each pinned
   * to one household ({@link restoreWindows}). The scope over them is composed
   * twice, and the two results are ANDed:
   *
   * - Under `update`: the ceiling the restore write is scoped by
   *   ({@link restoreHousehold}). Denials, pinned or not, and an API key's key
   *   scopes all apply there, so a household is listed only when the route
   *   would restore it, and this read does not restate how the loader ranks
   *   a denial against a grant.
   * - Under `read`: only a `read` composition is recorded, and the envelope's
   *   guard checks for one. It is also what entitles the actor to the roster
   *   each row carries. For a household owner it removes nothing: memberships
   *   of a deleted household are frozen, and `read:households` matches them.
   *
   * A grant pinned to no household is left out. It reaches every deleted
   * household, and staff list those at
   * `GET /admin/households?status=deleted` (#419).
   *
   * The grants, the rows and the count share one REPEATABLE READ transaction.
   * Read apart, staff restoring the household and deleting it again in
   * between would list the new deletion with the window the restore revoked:
   * a row that was never true. The ceilings would not catch it, since they
   * come from the abilities loaded when the request came in, which still hold
   * the revoked grant.
   *
   * `resolveScopeSubjectId` refuses `plugin`, `system` and `external` actors,
   * as for {@link getHouseholdsForUser}. PROVISIONAL — #395.
   */
  async getRestorableHouseholdsForUser(pagination: PaginationQueryDto): Promise<PaginatedRows<RestorableHousehold>> {
    const userId = resolveScopeSubjectId(this.abilityService);

    const { windows, rows, total } = await this.db.$transaction(
      async (tx) => {
        const windows = await this.restoreWindows(tx, userId);
        const scope: Prisma.HouseholdWhereInput = { deletedAt: { not: null }, id: { in: [...windows.keys()] } };

        const where: Prisma.HouseholdWhereInput = {
          AND: [
            this.scopeComposer.compose(ResourceType.Household, Action.read, scope),
            this.scopeComposer.compose(ResourceType.Household, Action.update, scope),
          ],
        };

        const rows = await tx.household.findMany(householdPageArgs(where, pagination));
        const total = await tx.household.count({ where });

        return { windows, rows, total };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return {
      rows: rows.map((row) => {
        // `null` means a grant with no end date, so it is never the fallback
        // for a row the scope let through without a window.
        const restorableUntil = windows.get(row.id);
        assert(restorableUntil !== undefined, `household ${row.id} was listed with no restore window`);

        return { ...row, restorableUntil };
      }),
      total,
    };
  }

  /**
   * The acting user's live grants of the restore permission, each pinned to a
   * household: when each one ends, keyed by household id. Never returned
   * as-is; only the household ceilings decide what is listed.
   *
   * Filtered as the ability loader filters direct permissions: unexpired, and
   * not of a retired permission. "Not a denial" is spelled as
   * {@link restoreHousehold} spells it, since `inverted` is nullable. A grant
   * with no end date is kept, since the restore route honours it.
   *
   * Read on the caller's transaction, so the windows come from the same
   * snapshot as the rows they are paired with.
   */
  private async restoreWindows(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<ReadonlyMap<string, Date | null>> {
    const grants = await tx.userPermission.findMany({
      where: {
        userId,
        resourceType: ResourceType.Household,
        resourceId: { not: null },
        permission: { slug: HOUSEHOLD_RESTORE_PERMISSION_SLUG, retiredAt: null },
        AND: [
          { OR: [{ inverted: null }, { inverted: false }] },
          { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        ],
      },
      select: { resourceId: true, expiresAt: true },
    });

    // The `where` already excludes a null `resourceId`; the generated type
    // cannot know that.
    return new Map(
      grants.flatMap(({ resourceId, expiresAt }) => (resourceId === null ? [] : [[resourceId, expiresAt] as const])),
    );
  }

  /**
   * One page of households plus the total matching row count for the response
   * envelope (#230). Scope is the caller's business; everything below it holds
   * whatever the scope, so a household list that declares a different one
   * (#485) would read through here rather than restate either invariant. A
   * list whose scope comes from its own read, as
   * {@link getRestorableHouseholdsForUser}'s does, makes that read in the same
   * transaction instead, through the same {@link householdPageArgs}.
   *
   * Rows and count share a REPEATABLE READ transaction: Prisma's default batch
   * isolation is the database default (READ COMMITTED on Postgres), where each
   * statement takes its own snapshot and a concurrent create or delete between
   * the two makes `hasMore` disagree with the rows actually sent.
   */
  private async paginateHouseholds(
    where: Prisma.HouseholdWhereInput,
    pagination: PaginationQueryDto,
  ): Promise<PaginatedRows<HouseholdWithRelations>> {
    const [rows, total] = await this.db.$transaction(
      [this.db.household.findMany(householdPageArgs(where, pagination)), this.db.household.count({ where })],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows, total };
  }

  /**
   * Soft-delete: the row is retained (`deletedAt` stamped) and hidden from every
   * read — `getHouseholdById`, `getHouseholdsForUser` and `updateHousehold` all
   * filter `deletedAt: null` — except {@link getRestorableHouseholdsForUser},
   * which lists it to the household owners who can still restore it (not to
   * staff, who can restore any). Outstanding invites to the household are
   * revoked in the same transaction so a stale token can never be accepted into
   * a dead household. Members and game-collection shares are intentionally left in
   * place — a soft delete is reversible ({@link restoreHousehold}) and reads
   * already exclude the household; hard cascade/cleanup is deferred to the
   * purge path (#543).
   *
   * That retention is load-bearing in the other direction too: because the
   * member rows survive, a membership clause alone still matches this household,
   * which is why the scope `getHouseholdsForUser` declares cannot drop its
   * `deletedAt` filter (#364). A read that adopts that scope inherits the
   * filter; one that builds its own membership clause must add it.
   *
   * ## Who can undo it (#175)
   *
   * When the actor is one of the household's owners, every owner gets a
   * recovery grant for {@link HOUSEHOLD_RESTORE_WINDOW_MS}, and
   * `restorableUntil` says when it ends. Every owner, because any owner may
   * delete, so a co-owner must not lose the household with no way back because
   * another one did.
   *
   * Any other actor gets no window: staff deleting through
   * `delete:household:administer`, or an actor with no user behind it. That is
   * moderation, and a grant to the owners would let them reverse it. Staff
   * restore through their own slug instead, and `restorableUntil` is `null`.
   *
   * Ownership decides, not which rule the write matched. Staff who are among
   * the household's owners delete as its owners, and every owner gets the
   * window: nothing in the request tells moderation from an owner deleting
   * their own household. Moderating a household they own is for staff who do
   * not.
   *
   * The other order has no shortcut. When an owner deleted first and staff
   * want the household to stay down, staff restore it and delete it again:
   * the restore revokes the owners' windows, and a staff delete issues none.
   *
   * ## What it publishes (#245)
   *
   * After commit, and after the revoked invites: the household deleted
   * domain event, whose audit entry names the household and the owners given
   * a restore window (none for a staff delete), and the
   * `household.household.deleted.v1` webhook, which carries the household's
   * id alone.
   */
  async deleteHousehold(id: string): Promise<HouseholdDeletion> {
    const initiatedAt = new Date();
    // `null` for an actor with no user behind it, which then owns nothing.
    const actorUserId = resolveActingUserIdOrNull(this.abilityService);

    try {
      // Existence first (→ 404); the scoped update below enforces the delete
      // policy (owner-only), and a non-matching `where` (→ P2025) maps to 403 —
      // consistent with updateHousehold and GameService.delete/update — unless a
      // concurrent delete landed in between (`scopedWriteRefusal`).
      await assertHouseholdExists(this.db, id);

      const { household, memberUserIds, recovery, revocation } = await this.db.$transaction(async (tx) => {
        const household = await tx.household.update({
          where: {
            id,
            deletedAt: null,
            // eslint-disable-next-line no-restricted-syntax -- single-row soft delete by id, not a collection read
            AND: this.abilityService.getCurrentResourceConditions(ResourceType.Household, Action.delete),
          },
          data: { deletedAt: new Date() },
        });

        // Outstanding invites to a dead household can never be accepted. The
        // lib is the only writer of an invite's status (#161); its events
        // ride back here and go out once the delete is committed.
        const revocation = await this.invites.revokeOutstandingWithin(tx, { householdId: id });

        // Member rows survive the soft delete; capture them so their cached
        // ability graphs can be evicted (the household just left their surface).
        // Read after the update, which holds the row lock a role transition
        // needs, so the owners seen here cannot be mid-swap.
        const members = await tx.householdMember.findMany({
          where: { householdId: id },
          select: { userId: true, role: { select: { role: { select: { name: true } } } } },
        });

        const ownerUserIds = members
          .filter((member) => member.role?.role.name === SystemRole.HouseholdOwner)
          .map((member) => member.userId);

        const recovery: RecoveryGrants =
          actorUserId !== null && ownerUserIds.includes(actorUserId)
            ? await this.grantRecovery(tx, id, ownerUserIds, actorUserId)
            : { restorableUntil: null, windowUserIds: [] };

        return { household, memberUserIds: members.map((member) => member.userId), recovery, revocation };
      });

      // Evict every member's graph so stale Household* abilities don't linger for
      // the cache TTL. The graph query also excludes soft-deleted memberships, so
      // the rebuild omits this household even before the eviction lands. The
      // owners are members, so the same eviction picks up their recovery grants.
      await this.permissions.invalidateUsers(memberUserIds);

      // Committed, so the revoked invites can be announced. `emit` logs a
      // failing listener rather than throwing it into this request.
      this.invites.emit(revocation.events);

      // The owners given a restore window go in the audit entry only (#245).
      this.publisher.publish(
        new HouseholdDeletedEvent(
          { id, name: household.name, restoreWindowUserIds: recovery.windowUserIds },
          initiatedAt,
        ),
        householdWebhook(WebhookEventType.HouseholdDeleted, { householdId: id }),
      );

      return { household, restorableUntil: recovery.restorableUntil };
    } catch (error) {
      // A scoped-update miss: the actor may not delete this household
      // (owner-only), or a concurrent delete got there first.
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw await this.scopedWriteRefusal(id, t('common.forbidden.delete'));
      }

      // The probe's 404, or any other client error, is an answer the endpoint
      // is specified to give, not a server failure, so it stays out of
      // error-level logs (#1427).
      if (error instanceof HttpException && error.getStatus() < 500) {
        throw error;
      }

      this.logger.error(`Error deleting household with id ${id}`, error);
      throw error;
    }
  }

  /**
   * What a scoped write on a household that matched nothing (P2025), or an
   * edit's scoped count that found nothing, should answer. A miss on
   * `deletedAt: null` rather than on permission means the household is unknown
   * or gone: a delete's existence probe takes no lock, so a soft-delete can
   * commit between it and the write, and the edit runs no probe at all. The
   * answer is then the 404 every route gives a deleted household (#299), not a
   * denial. Otherwise it is there and the actor may not do this: 403.
   *
   * Not logged: both are outcomes the endpoint is specified to produce.
   *
   * `client` is the connection the probe runs on. Inside a transaction it is
   * that transaction's, so a refusal never takes a second connection from the
   * pool while the transaction holds one (#245).
   */
  private async scopedWriteRefusal(
    id: string,
    forbidden: ReturnType<typeof t>,
    client: LockFreeReadClient = this.db,
  ): Promise<ForbiddenException | NotFoundException> {
    return householdRefusal(client, id, forbidden);
  }

  /**
   * Undoes {@link deleteHousehold} (#175): clears `deletedAt`, so every read
   * sees the household again and its members' household-scoped grants come
   * back. Revoked invites stay revoked.
   *
   * After commit the restore is published (#245): the household restored
   * domain event, whose audit entry records when the household was deleted
   * and the restore windows the restore ends, and the
   * `household.household.restored.v1` webhook, which carries the household's
   * id alone. A miss publishes nothing. The tombstone is read under the row
   * lock ({@link lockDeletedHousehold}), so the deletion the event records is
   * the one the restore undoes.
   *
   * The write is scoped by the actor's `update` rules on Household, and the
   * only ones that can match a deleted row are the two restore slugs, both
   * conditioned on the tombstone: an owner's recovery grant, pinned to this
   * household until its window ends, or staff's. The `deletedAt: { not: null }`
   * filter says the same thing again, so no other `update` rule can turn this
   * into an edit of a live household.
   *
   * An actor with no `update` rule on Household at all, such as a stranger or
   * an owner whose window lapsed, gets CASL's deny-all `{ OR: [] }`. Prisma
   * drops that inside `AND` (prisma#21856), which would leave only the
   * tombstone filter; `DatabaseService` installs `createCaslExtension`, which
   * hoists it to the top of the `where` so it holds.
   *
   * In the same transaction every recovery grant for the household goes,
   * whoever restored it: the window was for undoing THIS delete, and a
   * co-owner's grant outliving the restore would reach the household's next
   * one. That includes a grant an operator put on the key: a standing right to
   * restore is staff's slug, not this one. After commit every member is
   * evicted, since all of their household grants come back, not only the
   * restorer's.
   *
   * A household that is not deleted, and a miss (P2025), are resolved by
   * {@link restoreRefusal}: 409 when the household is live and the actor may
   * read it, otherwise 404.
   */
  async restoreHousehold(id: string): Promise<Household> {
    const initiatedAt = new Date();

    try {
      const restored = await this.db.$transaction(async (tx) => {
        // When the household was deleted, for the household restored domain
        // event (#245), read under the row lock so it is the deletion the
        // update below clears. A caller the update refuses rolls this back
        // with the rest, and learns nothing from it.
        const deletedAt = await lockDeletedHousehold(tx, id);

        // Live or unknown: nothing to restore, and no write to attempt.
        if (deletedAt === null) {
          return null;
        }

        const household = await tx.household.update({
          where: {
            id,
            deletedAt: { not: null },
            // eslint-disable-next-line no-restricted-syntax -- single-row restore by id, not a collection read
            AND: this.abilityService.getCurrentResourceConditions(ResourceType.Household, Action.update),
          },
          data: { deletedAt: null },
        });

        // Grants only. An operator's denial on the same key outlives the
        // restore, as it outlived the delete (`grantRecovery`). `inverted` is
        // nullable, so "not a denial" is spelled out: `NOT: { inverted: true }`
        // would drop the null rows.
        const windowGrants = {
          resourceType: ResourceType.Household,
          resourceId: id,
          permission: { slug: HOUSEHOLD_RESTORE_PERMISSION_SLUG },
          OR: [{ inverted: null }, { inverted: false }],
        } satisfies Prisma.UserPermissionWhereInput;

        // Who holds the windows the restore ends, for the household restored
        // domain event (#245). A lapsed grant, or one of a retired permission,
        // is not a restore window, as {@link restoreWindows} and the ability
        // loader count them, so the read leaves it out; the revocation below
        // still clears those rows.
        const windows = await tx.userPermission.findMany({
          where: {
            AND: [
              windowGrants,
              { permission: { retiredAt: null } },
              { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
            ],
          },
          select: { userId: true },
        });

        await tx.userPermission.deleteMany({ where: windowGrants });

        const members = await tx.householdMember.findMany({
          where: { householdId: id },
          select: { userId: true },
        });

        return {
          household,
          memberUserIds: members.map((member) => member.userId),
          deletedAt,
          windowUserIds: windows.map((grant) => grant.userId),
        };
      });

      if (restored === null) {
        throw await this.restoreRefusal(id);
      }

      const { household, memberUserIds, deletedAt, windowUserIds } = restored;

      await this.permissions.invalidateUsers(memberUserIds);

      this.publisher.publish(
        new HouseholdRestoredEvent(
          { id, deletedAt, restoreWindowUserIds: windowUserIds },
          { id, deletedAt: null, restoreWindowUserIds: [] },
          initiatedAt,
        ),
        householdWebhook(WebhookEventType.HouseholdRestored, { householdId: id }),
      );

      return household;
    } catch (error) {
      // The refusal for a household that is not deleted, thrown above: an
      // outcome the route is specified to produce, not a failure to log.
      if (error instanceof HttpException && error.getStatus() < 500) {
        throw error;
      }

      if (isPrismaDependentRecordNotFoundError(error)) {
        throw await this.restoreRefusal(id);
      }

      this.logger.error(`Error restoring household with id ${id}`, error);
      throw error;
    }
  }

  /**
   * Why a restore matched nothing, in the terms the caller may learn.
   *
   * 409 only when the household is live AND the actor can read it: an offline
   * retry of a restore that already landed, or a co-owner who got there first,
   * gets a distinct "already done". Everything else is 404, the same answer
   * whether the id is unknown, the window has lapsed, or the actor is a plain
   * member or a stranger. The probe is read-scoped for that reason: a stranger
   * learns nothing from the difference.
   */
  private async restoreRefusal(id: string): Promise<ConflictException | NotFoundException> {
    const readable = await this.db.household.count({
      where: {
        id,
        deletedAt: null,
        // eslint-disable-next-line no-restricted-syntax -- one-row existence probe by id, not a collection read
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.Household, Action.read),
      },
    });

    return readable > 0
      ? new ConflictException(t('errors.household.not_deleted', { id }))
      : new NotFoundException(t('errors.household.not_found', { id }));
  }

  /**
   * Issues each owner the recovery grant, all expiring together, and returns
   * when the acting owner's undo ends, or `null` when this delete opened none
   * for them, with the owners it gave a restore window: those whose grant it
   * created (#245).
   *
   * Create-only. Every restore revokes the household's recovery grants, so a
   * row already on an owner's key was put there by an operator, and it stays
   * exactly as set: a denial is not turned into a grant, and a grant is not
   * re-dated or re-attributed. That owner gets no new window, so they are not
   * among the owners returned, and when the owner is the actor their undo is
   * `null`: the response never promises an undo this delete did not open.
   *
   * An operator's denial of the slug pinned to no household also means `null`
   * while it is in force, because the loader applies denials after grants and
   * so it outranks the pinned one. The grant is still written, and counts if
   * the denial is lifted inside the window.
   *
   * A missing slug is a server error that rolls the delete back, not a delete
   * committed with no way to undo it.
   */
  private async grantRecovery(
    tx: Prisma.TransactionClient,
    householdId: string,
    ownerUserIds: readonly string[],
    grantedById: string,
  ): Promise<RecoveryGrants> {
    const permission = await tx.permission.findFirst({
      where: { slug: HOUSEHOLD_RESTORE_PERMISSION_SLUG, retiredAt: null },
      select: { id: true },
    });

    if (!permission) {
      throw new InternalServerErrorException(
        t('errors.household.permission_not_provisioned', { slug: HOUSEHOLD_RESTORE_PERMISSION_SLUG }),
      );
    }

    const now = Date.now();
    const expiresAt = new Date(now + HOUSEHOLD_RESTORE_WINDOW_MS);
    const onKey = { permissionId: permission.id, resourceType: ResourceType.Household };

    // One statement for every owner, and an existing row wins (ON CONFLICT DO
    // NOTHING). What comes back is only what this delete created.
    const created = await tx.userPermission.createManyAndReturn({
      data: ownerUserIds.map((userId) => ({ ...onKey, resourceId: householdId, userId, grantedById, expiresAt })),
      skipDuplicates: true,
      select: { userId: true },
    });
    const windowUserIds = created.map((grant) => grant.userId);

    if (!windowUserIds.includes(grantedById)) {
      return { restorableUntil: null, windowUserIds };
    }

    const deniedEverywhere = await tx.userPermission.count({
      where: {
        ...onKey,
        userId: grantedById,
        resourceId: null,
        inverted: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(now) } }],
      },
    });

    return { restorableUntil: deniedEverywhere > 0 ? null : expiresAt, windowUserIds };
  }
}
