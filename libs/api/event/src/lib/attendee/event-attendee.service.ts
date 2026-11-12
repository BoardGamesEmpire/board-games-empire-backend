import {
  Action,
  DatabaseService,
  EventAttendee,
  EventAttendeeGameList,
  EventParticipationStatus,
  GameCollection,
  isPrismaDependentRecordNotFoundError,
  isPrismaUniqueConstraintError,
  Prisma,
  ResourceType,
  SystemRole,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, PermissionsService, resolveActingUserIdOrNull, ScopeComposer } from '@bge/permissions';
import type { PaginatedRows, PaginationQueryDto } from '@bge/shared';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import assert from 'node:assert';
import { ATTENDEE_ORDER } from '../constants/attendee-order.constant';
import { ATTENDEE_USER_AND_ROLE_INCLUDE } from '../constants/attendee-user-and-role.constant';
import { NOT_REMOVED } from '../constants/not-removed.constant';
import { assertEventExists, requireEvent } from '../event-access.helpers';
import { OFFERED_GAME_SELECT } from '../offered-game/offered-game.select';
import { OfferedGameService } from '../offered-game/offered-game.service';
import type { OfferedGame, OfferedGameEntry } from '../offered-game/offered-game.types';
import {
  ACTIVE_NOMINATION_STATUSES,
  emitSuppliedGameChanges,
  lineupStillAhead,
  lockEventDates,
  syncSuppliedGames,
} from './attendance';
import { AddAttendeeDto } from './dto/add-attendee.dto';
import { AddGameToListDto } from './dto/add-game-to-list.dto';
import { OfferGamesDto, type OfferGameItemDto } from './dto/offer-games.dto';
import { UpdateAttendeeStatusDto } from './dto/update-attendee-status.dto';
import {
  AttendeeAddedEvent,
  AttendeeRemovedEvent,
  AttendeeStatusUpdatedEvent,
  GameAddedToListEvent,
  GameRemovedFromListEvent,
} from './events/attendee.events';
import { assertInvitable } from './invitable';
import { OfferRefusal, offerRefusalMessage, type OfferResult } from './offer-outcome';

/** An attendee row with their user and role. */
type AttendeeRow = Prisma.EventAttendeeGetPayload<{ include: typeof ATTENDEE_USER_AND_ROLE_INCLUDE }>;

/**
 * An attendee as every attendee route serves one: their user and role, and
 * the games they offer, read on their own under the offered-games read
 * ceiling (#404, #1187).
 */
export type AttendeeWithGames = AttendeeRow & {
  availableGames: OfferedGame[];
};

@Injectable()
export class EventAttendeeService {
  private readonly logger = new Logger(EventAttendeeService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly eventEmitter: EventEmitter2,
    private readonly abilityService: AbilityService,
    private readonly permissions: PermissionsService,
    private readonly scopeComposer: ScopeComposer,
    private readonly offeredGames: OfferedGameService,
  ) {}

  /**
   * One page of the event's attendees the caller may read, plus the total for
   * the response envelope. The scope is the path's event, composed with the
   * caller's ceiling (#512), without the attendees a host removed (#551); the
   * count runs through the same where, so a removed attendee leaves the total
   * too.
   *
   * This read returned every attendee of the event until #373 paged it; the
   * response is a truncating change, which pre-alpha allows without a shim.
   *
   * The order is {@link ATTENDEE_ORDER}. Its `id` tie-breaker holds attendees
   * added in one write in place between requests; it cannot stop a removal or a
   * re-add from shifting the rows after it. Pages are offsets into a live list,
   * so a client paging through one meanwhile can miss or repeat an attendee.
   *
   * The existence probe runs ahead of the read and outside its transaction, as
   * in `getOccurrences`. A soft delete keeps the attendee rows, so an event
   * deleted between the two answers 200 with its attendees rather than 404, as
   * a read just ahead of the delete would. The rows and count share one
   * snapshot.
   *
   * Each attendee's games are read after the page, under their own ceiling
   * (#404, #1187).
   */
  async getAttendees(eventId: string, pagination: PaginationQueryDto): Promise<PaginatedRows<AttendeeWithGames>> {
    await assertEventExists(this.db, eventId);

    const where = this.scopeComposer.compose(ResourceType.EventAttendee, Action.read, { eventId, ...NOT_REMOVED });

    const [rows, total] = await this.db.$transaction(
      [
        this.db.eventAttendee.findMany({
          where,
          include: ATTENDEE_USER_AND_ROLE_INCLUDE,
          orderBy: ATTENDEE_ORDER,
          skip: pagination.skip,
          take: pagination.pageSize,
        }),

        this.db.eventAttendee.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows: await this.withGames(rows, new Date()), total };
  }

  async getAttendee(eventId: string, attendeeId: string): Promise<AttendeeWithGames> {
    await assertEventExists(this.db, eventId);

    const attendee = await this.db.eventAttendee.findUnique({
      where: {
        id: attendeeId,
        eventId,
        ...NOT_REMOVED,
        // eslint-disable-next-line no-restricted-syntax -- single-row fetch by id, not a collection read
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventAttendee, Action.read),
      },
      include: ATTENDEE_USER_AND_ROLE_INCLUDE,
    });

    if (!attendee) {
      throw new NotFoundException(t('errors.attendee.not_found', { attendeeId, eventId }));
    }

    return this.withGamesOf(attendee, new Date());
  }

  async getAttendeeByUserId(eventId: string, userId: string): Promise<AttendeeWithGames> {
    await assertEventExists(this.db, eventId);

    const attendee = await this.db.eventAttendee.findUnique({
      where: {
        eventId_userId: { eventId, userId },
        ...NOT_REMOVED,
        // eslint-disable-next-line no-restricted-syntax -- single-row fetch by its unique (event, user) key, not a collection read
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventAttendee, Action.read),
      },
      include: ATTENDEE_USER_AND_ROLE_INCLUDE,
    });

    assert(attendee, new NotFoundException(t('errors.attendee.not_found_for_user', { userId, eventId })));
    return this.withGamesOf(attendee, new Date());
  }

  async addAttendee(eventId: string, dto: AddAttendeeDto): Promise<AttendeeWithGames> {
    const initiatedAt = new Date();
    const event = await requireEvent(this.db, eventId);
    const invitedByUserId = this.abilityService.getActingUserId();
    const roleName = dto.role ?? SystemRole.EventParticipant;

    // The route's policy check judges a create by type alone, and every host
    // holds one for their own event, so on its own it lets the host of any
    // event add attendees to every event. Bind it to the row about to be
    // written: the event's own grants name its id, the household variant its
    // household, and an organizer's or moderator's the roles they may give
    // out. Those grants refuse a subject that names no role, so the role is
    // always named.
    this.abilityService.assertCurrentActorCan(Action.create, ResourceType.EventAttendee, {
      eventId,
      event: { householdId: event.householdId },
      role: { role: { name: roleName } },
    });

    if (!dto.userId && !dto.guestName) {
      throw new BadRequestException(t('errors.attendee.user_or_guest_required'));
    }

    const inviter = await this.db.eventAttendee.findUnique({
      where: { eventId_userId: { eventId, userId: invitedByUserId }, ...NOT_REMOVED },
      select: { id: true },
    });

    // A user a host removed keeps their row, and the (event, user) key with
    // it, so adding them again revives that row (#551). One still on the
    // event answers as the duplicate they are, before the checks below ask
    // whether they may be placed on it.
    const existing = dto.userId
      ? await this.db.eventAttendee.findFirst({
          where: { eventId, userId: dto.userId },
          select: { id: true, status: true, invitedById: true, removedAt: true },
        })
      : null;

    if (existing && existing.removedAt === null) {
      throw new ConflictException(t('errors.attendee.already_attendee'));
    }

    const removed = existing;
    let added: AttendeeRow;

    try {
      const fields = {
        guestName: dto.guestName,
        guestEmail: dto.guestEmail,
        status: dto.status ?? EventParticipationStatus.Invited,
        notes: dto.notes,
        role: {
          create: {
            role: { connect: { name: roleName } },
          },
        },
      };

      const { attendee, changes } = await this.db.$transaction(async (tx) => {
        // Whom the caller may place on the event, as the event's create asks
        // of its invitees (#546).
        if (dto.userId) {
          await assertInvitable(tx, invitedByUserId, [dto.userId]);
        }

        if (!removed) {
          const attendee = await tx.eventAttendee.create({
            data: {
              ...fields,
              event: { connect: { id: eventId } },
              user: dto.userId ? { connect: { id: dto.userId } } : undefined,
              invitedBy: inviter ? { connect: { id: inviter.id } } : undefined,
            },
            include: ATTENDEE_USER_AND_ROLE_INCLUDE,
          });

          return { attendee, changes: null };
        }

        const attendee = await tx.eventAttendee.update({
          // Matches nothing once a concurrent add has revived it, which
          // answers as the duplicate it then is.
          where: { id: removed.id, removedAt: { not: null } },
          data: {
            ...fields,
            removedAt: null,
            rsvpDate: null,
            invitedBy: inviter ? { connect: { id: inviter.id } } : { disconnect: true },
          },
          include: ATTENDEE_USER_AND_ROLE_INCLUDE,
        });

        return { attendee, changes: await syncSuppliedGames(tx, attendee, initiatedAt) };
      });

      this.eventEmitter.emit(
        AttendeeAddedEvent.eventName,
        new AttendeeAddedEvent(
          removed ?? null,
          {
            id: attendee.id,
            eventId: attendee.eventId,
            userId: attendee.userId,
            guestName: attendee.guestName,
            status: attendee.status,
            invitedById: attendee.invitedById,
            ...(removed ? { removedAt: attendee.removedAt } : {}),
          },
          initiatedAt,
        ),
      );

      if (changes) {
        emitSuppliedGameChanges(this.eventEmitter, eventId, changes, initiatedAt);
      }

      // The added user's cached graph predates this row, so their role here
      // would otherwise reach them only when the cache expires.
      await this.permissions.invalidateUser(attendee.userId);
      added = attendee;
    } catch (error) {
      this.logger.error(`Error adding attendee to event ${eventId}`, error);

      if (isPrismaUniqueConstraintError(error) || (removed && isPrismaDependentRecordNotFoundError(error))) {
        throw new ConflictException(t('errors.attendee.already_attendee'));
      }

      throw error;
    }

    // Outside the try: the add has committed, so a failure here is the
    // read's, never a duplicate add (#1187).
    return this.withGamesOf(added, initiatedAt);
  }

  /**
   * Removes an attendee from the event, keeping their row (#551).
   *
   * The row is marked removed rather than deleted: the nominations and votes
   * it made keep their author, and adding the same user again revives it.
   * Nothing else that points at the row is touched, so no key into it can
   * refuse the removal. Their role is deleted, which takes every event grant
   * with it, since event grants render only from that role. Then they are out
   * of the event, as someone not attending is: the games they supply are
   * brought into line in the same transaction (`syncSuppliedGames`).
   */
  async removeAttendee(eventId: string, attendeeId: string): Promise<AttendeeWithGames> {
    const initiatedAt = new Date();
    // Attribution guard: removal must be performed by a user-attributed
    // actor — system/external actors throw here instead of silently removing
    // attendees. The id also rides the domain event, so the listener can tell the
    // person removed unless they removed themselves (#802).
    const actingUserId = this.abilityService.getActingUserId();
    await assertEventExists(this.db, eventId);

    const attendee = await this.db.eventAttendee.findUnique({
      where: { id: attendeeId, eventId, ...NOT_REMOVED },
      select: { id: true, userId: true },
    });

    assert(attendee, new NotFoundException(t('errors.attendee.not_found', { attendeeId, eventId })));
    let taken: AttendeeRow;

    try {
      const { removed, changes } = await this.db.$transaction(async (tx) => {
        // The check reads the row's role, so it runs before the role goes.
        const marked = await tx.eventAttendee.update({
          where: {
            id: attendeeId,
            ...NOT_REMOVED,
            // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
            AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventAttendee, Action.delete),
          },
          data: { removedAt: new Date() },
          select: { id: true },
        });

        await tx.eventAttendeeRole.deleteMany({ where: { eventAttendeeId: marked.id } });

        const removed = await tx.eventAttendee.findUniqueOrThrow({
          where: { id: marked.id },
          include: ATTENDEE_USER_AND_ROLE_INCLUDE,
        });
        return { removed, changes: await syncSuppliedGames(tx, removed, initiatedAt) };
      });

      const snapshot = {
        id: removed.id,
        eventId: removed.eventId,
        userId: removed.userId,
        guestName: removed.guestName,
        status: removed.status,
      };

      this.eventEmitter.emit(
        AttendeeRemovedEvent.eventName,
        new AttendeeRemovedEvent(
          { ...snapshot, removedAt: null },
          { ...snapshot, removedAt: removed.removedAt },
          actingUserId,
          initiatedAt,
        ),
      );
      emitSuppliedGameChanges(this.eventEmitter, eventId, changes, initiatedAt);

      // The event just left this user's ability surface. Without the eviction
      // a removed co-host keeps co-hosting until the cached graph expires.
      await this.permissions.invalidateUser(removed.userId);
      taken = removed;
    } catch (error) {
      this.logger.error(`Error removing attendee ${attendeeId} from event ${eventId}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('errors.attendee.forbidden_remove'));
      }
      throw error;
    }

    // Outside the try: the removal has committed, so a failure here is the
    // read's, never a refused removal (#1187).
    return this.withGamesOf(taken, initiatedAt);
  }

  async updateStatus(eventId: string, attendeeId: string, dto: UpdateAttendeeStatusDto): Promise<AttendeeWithGames> {
    const initiatedAt = new Date();
    const actingUserId = resolveActingUserIdOrNull(this.abilityService);
    await assertEventExists(this.db, eventId);

    const existing = await this.db.eventAttendee.findUnique({
      where: { id: attendeeId, eventId, ...NOT_REMOVED },
      select: { id: true, userId: true },
    });

    if (!existing) {
      throw new NotFoundException(t('errors.attendee.not_found', { attendeeId, eventId }));
    }

    const rsvpDate =
      dto.status === EventParticipationStatus.Attending || dto.status === EventParticipationStatus.NotAttending
        ? new Date()
        : undefined;
    let answered: AttendeeRow;

    try {
      // Not attending takes the attendee out of the event, and any other
      // answer brings them back in (#551): the games they supply follow, in
      // the same transaction.
      const { previous, updated, changes } = await this.db.$transaction(async (tx) => {
        // The status this write replaces, read under the row lock the update
        // takes anyway. The read above runs before the lock, so two RSVPs
        // racing each other would both report the status neither left, and
        // the listener would take the second for an RSVP sent again
        // unchanged and tell nobody (#802). A row gone by now fails the
        // update below, as before.
        const [previous] = await tx.$queryRaw<{ status: EventParticipationStatus }[]>(
          Prisma.sql`SELECT status FROM event_attendees WHERE id = ${attendeeId} FOR NO KEY UPDATE`,
        );

        const updated = await tx.eventAttendee.update({
          where: {
            id: attendeeId,
            ...NOT_REMOVED,
            // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
            AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventAttendee, Action.update),
          },
          data: {
            status: dto.status,
            notes: dto.notes ?? undefined,
            rsvpDate,
          },
          include: ATTENDEE_USER_AND_ROLE_INCLUDE,
        });

        return { previous, updated, changes: await syncSuppliedGames(tx, updated, initiatedAt) };
      });

      this.eventEmitter.emit(
        AttendeeStatusUpdatedEvent.eventName,
        new AttendeeStatusUpdatedEvent(
          { id: attendeeId, eventId, userId: existing.userId, status: previous.status },
          { id: updated.id, eventId: updated.eventId, userId: updated.userId, status: updated.status },
          actingUserId,
          initiatedAt,
        ),
      );
      emitSuppliedGameChanges(this.eventEmitter, eventId, changes, initiatedAt);
      answered = updated;
    } catch (error) {
      this.logger.error(`Error updating status for attendee ${attendeeId} in event ${eventId}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('errors.attendee.forbidden_update'));
      }
      throw error;
    }

    // Outside the try: the answer has committed, so a failure here is the
    // read's, never a refused update (#1187).
    return this.withGamesOf(answered, initiatedAt);
  }

  /**
   * One page of the games an attendee offers, as far as the caller may read
   * them (#1001): the offered-games read with the attendee fixed, in its
   * shape and order (#1187). The attendee's own clause leaves their entries
   * out the moment they're removed, as the event-wide read does. Filtering
   * one attendee's games is `?attendeeIds=` on that read.
   */
  async getGameList(
    eventId: string,
    attendeeId: string,
    pagination: PaginationQueryDto,
  ): Promise<PaginatedRows<OfferedGame>> {
    await assertEventExists(this.db, eventId);
    await this.assertAttendeeExists(eventId, attendeeId);

    return this.offeredGames.page(
      { attendeeId, ...NOT_REMOVED, attendee: { is: { eventId, ...NOT_REMOVED } } },
      pagination,
      new Date(),
    );
  }

  /**
   * Offers one of the attendee's collection entries to the event, answering
   * with it in the offered-game shape (#1185, #1187).
   */
  async addGameToList(eventId: string, attendeeId: string, dto: AddGameToListDto): Promise<OfferedGame> {
    const initiatedAt = new Date();
    const attendee = await this.requireOfferTarget(eventId, attendeeId);

    const collection = await this.db.gameCollection.findUnique({
      where: { id: dto.collectionId },
      select: { userId: true, deletedAt: true },
    });
    const refusal = judgeCollectionEntry(attendee, collection);

    if (refusal) {
      throw offerRefusalException(refusal, dto.collectionId);
    }

    // A game taken off the list keeps its row, and the (attendee, game) key
    // with it, so putting it back revives that row (#551).
    const removed = await this.db.eventAttendeeGameList.findFirst({
      where: { attendeeId, collectionId: dto.collectionId, removedAt: { not: null } },
      select: { id: true, attendeeId: true, collectionId: true, removedAt: true },
    });

    let entry: OfferedGameEntry;

    try {
      entry = await this.writeOffer(eventId, attendeeId, dto.collectionId, removed, initiatedAt);
    } catch (error) {
      if (isPrismaUniqueConstraintError(error) || (removed && isPrismaDependentRecordNotFoundError(error))) {
        throw new ConflictException(t('errors.attendee.game_already_in_list'));
      }

      // No row to connect on a create: the collection entry was deleted since
      // the check, as the batch reads it (#1188).
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw offerRefusalException(OfferRefusal.NotFound, dto.collectionId);
      }

      this.logger.error(`Error adding game to list for attendee ${attendeeId}`, error);
      throw error;
    }

    // Outside the try: the offer has committed, so a failure here is the
    // read's, never a duplicate offer (#1187).
    const [offered] = await this.offeredGames.enrich([entry], initiatedAt);
    return offered;
  }

  /**
   * Offers several of the attendee's collection entries at once, each a game
   * with a choice of its expansions, answering what happened to each, in
   * request order, each expansion right after its game (#1188).
   *
   * - Each id is judged as the single add judges one. A bad id is refused
   *   with a stable reason and a translated message, and loses nothing else.
   * - An expansion must also expand its item's game: a `GameExpansion` link
   *   from that game to its own, the direction base games are read in. The
   *   expansions of a refused game are refused as `baseRefused`; those of a
   *   game already offered go ahead.
   * - An entry already offered is `alreadyOffered`, with its entry, and
   *   emits nothing, before any judgement: nothing is written for it, so
   *   nothing is refused. That holds for one removed from its collection
   *   since, which stays offered until taken back. One taken back earlier
   *   comes back with its id.
   * - The create check runs once, as the single add's, before anything is
   *   read. Every id is judged from three reads, whatever the batch's size.
   * - Each accepted id is its own statement. A write that fails on what
   *   changed since the judgement answers for that id alone (`offerOne`).
   *   Any other database failure fails the request, keeping the entries
   *   written before it; sending the batch again answers those
   *   `alreadyOffered` and offers the rest. Each added entry emits its own
   *   `GameAddedToListEvent`, as the single add does.
   *
   * Like the single add, it checks no collection's owner for an attendee
   * added by name (#1210).
   */
  async offerGames(eventId: string, attendeeId: string, dto: OfferGamesDto): Promise<OfferResult[]> {
    const initiatedAt = new Date();
    const attendee = await this.requireOfferTarget(eventId, attendeeId);
    const named = dto.items.flatMap((item) => [item.collectionId, ...(item.expansionCollectionIds ?? [])]);

    const [collections, listed] = await Promise.all([
      this.db.gameCollection.findMany({
        where: { id: { in: named } },
        select: { id: true, userId: true, deletedAt: true, platformGame: { select: { gameId: true } } },
      }),
      this.db.eventAttendeeGameList.findMany({
        where: { attendeeId, collectionId: { in: named } },
        select: { ...OFFERED_GAME_SELECT, collectionId: true, removedAt: true },
      }),
    ]);
    const collectionById = new Map(collections.map((collection) => [collection.id, collection]));
    const listedByCollection = new Map(listed.map((entry) => [entry.collectionId, entry]));
    const links = await this.expansionLinks(dto.items, collectionById);

    // An entry already offered goes ahead unjudged: `offerOne` answers it
    // `alreadyOffered` and writes nothing.
    const offered = (collectionId: string) => listedByCollection.get(collectionId)?.removedAt === null;

    const judged: { collectionId: string; baseId?: string; refusal: OfferRefusal | null }[] = [];
    for (const item of dto.items) {
      const game = collectionById.get(item.collectionId);
      const gameRefusal = offered(item.collectionId) ? null : judgeCollectionEntry(attendee, game);
      judged.push({ collectionId: item.collectionId, refusal: gameRefusal });

      for (const expansionId of item.expansionCollectionIds ?? []) {
        const expansion = collectionById.get(expansionId);
        const refusal = offered(expansionId)
          ? null
          : gameRefusal === null
            ? (judgeCollectionEntry(attendee, expansion) ??
              (game && expansion && links.has(linkKey(game.platformGame.gameId, expansion.platformGame.gameId))
                ? null
                : OfferRefusal.NotAnExpansionOfBase))
            : OfferRefusal.BaseRefused;
        judged.push({ collectionId: expansionId, baseId: item.collectionId, refusal });
      }
    }

    // One at a time, in request order, each its own statement. A game whose
    // write is refused (its entry deleted since the judgement, as deleting
    // the game does) refuses the expansions still to write with it, as a
    // game refused at judging does; one already offered stays so.
    const refusedAtWrite = new Set<string>();
    const settled: (
      | { collectionId: string; refusal: OfferRefusal }
      | { collectionId: string; outcome: 'added' | 'alreadyOffered'; entry: OfferedGameEntry }
    )[] = [];
    for (const { collectionId, baseId, refusal } of judged) {
      const settledRefusal =
        refusal ??
        (baseId !== undefined && refusedAtWrite.has(baseId) && !offered(collectionId)
          ? OfferRefusal.BaseRefused
          : null);

      if (settledRefusal !== null) {
        settled.push({ collectionId, refusal: settledRefusal });
        continue;
      }

      const result = await this.offerOne(
        eventId,
        attendeeId,
        collectionId,
        listedByCollection.get(collectionId),
        initiatedAt,
      );

      if ('refusal' in result) {
        refusedAtWrite.add(collectionId);
      }

      settled.push({ collectionId, ...result });
    }

    // `enrich` keeps the order it's given, so the entries come back in turn.
    const enriched = await this.offeredGames.enrich(
      settled.flatMap((result) => ('entry' in result ? [result.entry] : [])),
      initiatedAt,
    );
    let next = 0;

    return settled.map((result): OfferResult =>
      'entry' in result
        ? { collectionId: result.collectionId, outcome: result.outcome, entry: enriched[next++] }
        : {
            collectionId: result.collectionId,
            outcome: 'refused',
            reason: result.refusal,
            message: offerRefusalMessage(result.refusal, result.collectionId),
          },
    );
  }

  /**
   * Takes a game off an attendee's list, keeping its row (#551).
   *
   * Refused with 409 while the entry supplies the event: a nomination that
   * has not reached an outcome, paused ones included, or a game in the lineup
   * of a date still ahead (`lineupStillAhead`). Taking a game off the list
   * never takes it out of the lineup by itself: its supplier leaving the
   * event does, and so does a date write that puts a started date's lineup
   * ahead again (`writeEventDates`). Otherwise the row is marked removed, not
   * deleted, because closed nominations, and the lineups of dates that have
   * started, still name it as their supplier.
   *
   * The entry is locked `FOR UPDATE` before the check, so a nomination or
   * direct add naming it either commits first and is counted, or waits
   * (`lockSupplier`) and then finds it removed. The event's dates are locked
   * too (`lockEventDates`), so a date write that puts a lineup ahead again
   * either commits first and the game is counted, or waits and then takes
   * the game off itself.
   */
  async removeGameFromList(eventId: string, attendeeId: string, gameListId: string): Promise<EventAttendeeGameList> {
    const initiatedAt = new Date();
    await this.assertAttendeeExists(eventId, attendeeId);

    const entry = await this.db.eventAttendeeGameList.findUnique({
      where: { id: gameListId, attendeeId, ...NOT_REMOVED },
    });

    if (!entry) {
      throw new NotFoundException(t('errors.attendee.game_list_entry_not_found', { gameListId, attendeeId }));
    }

    try {
      const removed = await this.db.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<{ removedAt: Date | null }[]>(
          Prisma.sql`SELECT removed_at AS "removedAt" FROM attendee_game_lists WHERE id = ${gameListId} FOR UPDATE`,
        );

        // A concurrent request took it off since the read above.
        if (!locked || locked.removedAt !== null) {
          throw new NotFoundException(t('errors.attendee.game_list_entry_not_found', { gameListId, attendeeId }));
        }

        // Whether the caller may take it off at all comes first, so the 409
        // below, which names what the game supplies, goes only to someone who
        // could have removed it.
        const permitted = await tx.eventAttendeeGameList.count({
          where: {
            id: gameListId,
            // eslint-disable-next-line no-restricted-syntax -- single-row check by id, not a collection read
            AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventAttendeeGameList, Action.delete),
          },
        });

        if (permitted === 0) {
          throw new ForbiddenException(t('errors.attendee.forbidden_remove_game'));
        }

        await lockEventDates(tx, eventId);

        const nominations = await tx.eventGameNomination.count({
          where: { suppliedFromId: gameListId, status: { in: ACTIVE_NOMINATION_STATUSES } },
        });
        const scheduled = await tx.eventGame.count({
          where: { suppliedById: gameListId, ...lineupStillAhead(initiatedAt) },
        });

        if (nominations > 0 || scheduled > 0) {
          throw new ConflictException(t('errors.attendee.game_still_supplied', { nominations, scheduled }));
        }

        return tx.eventAttendeeGameList.update({
          where: {
            id: gameListId,
            ...NOT_REMOVED,
            // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
            AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventAttendeeGameList, Action.delete),
          },
          data: { removedAt: new Date() },
        });
      });

      const snapshot = { id: removed.id, attendeeId: removed.attendeeId, collectionId: removed.collectionId };

      this.eventEmitter.emit(
        GameRemovedFromListEvent.eventName,
        new GameRemovedFromListEvent(
          { ...snapshot, removedAt: null },
          { ...snapshot, removedAt: removed.removedAt },
          eventId,
          initiatedAt,
        ),
      );

      return removed;
    } catch (error) {
      this.logger.error(`Error removing game ${gameListId} from attendee ${attendeeId} list`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('errors.attendee.forbidden_remove_game'));
      }
      throw error;
    }
  }

  /**
   * The event and attendee an offer writes to, once the caller may offer
   * games for that attendee. The route's policy check judges a create by
   * type alone, and `manage` implies `create`: a participant passes it for
   * their own offered games, a manager for any attendee's in the event. Bind
   * it to the attendee about to offer, carrying their user and event so
   * either grant can match.
   */
  private async requireOfferTarget(eventId: string, attendeeId: string): Promise<Pick<EventAttendee, 'id' | 'userId'>> {
    const event = await requireEvent(this.db, eventId);
    const attendee = await this.assertAttendeeExists(eventId, attendeeId);

    this.abilityService.assertCurrentActorCan(Action.create, ResourceType.EventAttendeeGameList, {
      attendeeId,
      attendee: { id: attendeeId, userId: attendee.userId, eventId, event: { householdId: event.householdId } },
    });

    return attendee;
  }

  /**
   * Offers `collectionId` for the attendee: a new entry, or the entry
   * `removed` names, taken back earlier and revived with its id (#551). Emits
   * the `GameAddedToListEvent`. A concurrent add surfaces as Prisma's own
   * error: a unique-key clash on a create, or no row matched on a revive.
   */
  private async writeOffer(
    eventId: string,
    attendeeId: string,
    collectionId: string,
    removed: Pick<EventAttendeeGameList, 'id' | 'attendeeId' | 'collectionId' | 'removedAt'> | null,
    initiatedAt: Date,
  ): Promise<OfferedGameEntry> {
    const entry = removed
      ? await this.db.eventAttendeeGameList.update({
          // Matches nothing once a concurrent add has revived it, which
          // answers as the duplicate it then is.
          where: { id: removed.id, removedAt: { not: null } },
          data: { removedAt: null },
          select: OFFERED_GAME_SELECT,
        })
      : await this.db.eventAttendeeGameList.create({
          data: {
            attendee: { connect: { id: attendeeId } },
            collection: { connect: { id: collectionId } },
          },
          select: OFFERED_GAME_SELECT,
        });

    this.eventEmitter.emit(
      GameAddedToListEvent.eventName,
      new GameAddedToListEvent(
        removed ?? null,
        // The shape carries neither column, and both are known: the entry
        // offers the named collection entry, and is offered now.
        { id: entry.id, attendeeId: entry.attendeeId, collectionId, removedAt: null },
        eventId,
        initiatedAt,
      ),
    );

    return entry;
  }

  /**
   * One accepted id of a batch offer (#1188): `alreadyOffered` when it's
   * offered already, else written. A bad id loses nothing else, so a write
   * that fails on what changed since the judgement answers for this id alone:
   *
   * - one that loses a concurrent add's race reads the winner's entry and
   *   answers `alreadyOffered` with it;
   * - one whose collection entry was deleted since is refused `notFound`.
   *   Its owner's account, or its platform game, takes it with them. The
   *   attendee's row can't be what's missing: it goes only with its event's,
   *   and no route deletes an event's row.
   *
   * Any other failure is the database's, and fails the request.
   */
  private async offerOne(
    eventId: string,
    attendeeId: string,
    collectionId: string,
    listed: (OfferedGameEntry & Pick<EventAttendeeGameList, 'collectionId' | 'removedAt'>) | undefined,
    initiatedAt: Date,
  ): Promise<{ outcome: 'added' | 'alreadyOffered'; entry: OfferedGameEntry } | { refusal: OfferRefusal }> {
    if (listed && listed.removedAt === null) {
      const { id, attendeeId: listedBy, createdAt, collection } = listed;

      return { outcome: 'alreadyOffered', entry: { id, attendeeId: listedBy, createdAt, collection } };
    }

    const removed = listed
      ? { id: listed.id, attendeeId: listed.attendeeId, collectionId, removedAt: listed.removedAt }
      : null;

    try {
      return {
        outcome: 'added',
        entry: await this.writeOffer(eventId, attendeeId, collectionId, removed, initiatedAt),
      };
    } catch (error) {
      // A unique-key clash on a create, or no row matched on a revive, is a
      // concurrent add. No row to connect on a create is a deleted entry.
      if (isPrismaUniqueConstraintError(error) || isPrismaDependentRecordNotFoundError(error)) {
        const entry = await this.db.eventAttendeeGameList.findFirst({
          where: { attendeeId, collectionId, removedAt: null },
          select: OFFERED_GAME_SELECT,
        });

        if (entry) {
          return { outcome: 'alreadyOffered', entry };
        }

        if (isPrismaDependentRecordNotFoundError(error)) {
          return { refusal: OfferRefusal.NotFound };
        }
      }

      this.logger.error(`Error offering collection entry ${collectionId} for attendee ${attendeeId}`, error);
      throw error;
    }
  }

  /**
   * The expansion links among a batch's (item game, expansion game) pairs,
   * as {@link linkKey}s, read once (#1188). The link's direction says which
   * game is the base: only a link from the item's game to the expansion's
   * counts.
   */
  private async expansionLinks(
    items: readonly OfferGameItemDto[],
    collectionById: ReadonlyMap<string, { platformGame: { gameId: string } }>,
  ): Promise<ReadonlySet<string>> {
    const pairs = items.flatMap((item) => {
      const game = collectionById.get(item.collectionId)?.platformGame.gameId;

      return (item.expansionCollectionIds ?? []).flatMap((expansionId) => {
        const expansion = collectionById.get(expansionId)?.platformGame.gameId;

        return game && expansion ? [{ game, expansion }] : [];
      });
    });

    if (pairs.length === 0) {
      return new Set();
    }

    const links = await this.db.gameExpansion.findMany({
      where: {
        baseGameId: { in: [...new Set(pairs.map(({ game }) => game))] },
        expansionGameId: { in: [...new Set(pairs.map(({ expansion }) => expansion))] },
      },
      select: { baseGameId: true, expansionGameId: true },
    });

    return new Set(links.map(({ baseGameId, expansionGameId }) => linkKey(baseGameId, expansionGameId)));
  }

  /**
   * Each attendee with the games they offer, read under the offered-games
   * read ceiling after the attendees themselves (#404, #1187). A write calls it after its
   * transaction commits, so the games are the ones offered now.
   */
  private async withGames<T extends { id: string }>(
    attendees: readonly T[],
    now: Date,
  ): Promise<(T & { availableGames: OfferedGame[] })[]> {
    const games = await this.offeredGames.forAttendees(
      attendees.map((attendee) => attendee.id),
      now,
    );

    return attendees.map((attendee) => ({ ...attendee, availableGames: games.get(attendee.id) ?? [] }));
  }

  /** One attendee with the games they offer, as {@link withGames} reads them. */
  private async withGamesOf<T extends { id: string }>(
    attendee: T,
    now: Date,
  ): Promise<T & { availableGames: OfferedGame[] }> {
    const [withGames] = await this.withGames([attendee], now);

    return withGames;
  }

  private async assertAttendeeExists(
    eventId: string,
    attendeeId: string,
  ): Promise<Pick<EventAttendee, 'id' | 'userId'>> {
    const attendee = await this.db.eventAttendee.findUnique({
      where: { id: attendeeId, eventId, ...NOT_REMOVED },
      select: { id: true, userId: true },
    });

    if (!attendee) {
      throw new NotFoundException(t('errors.attendee.not_found', { attendeeId, eventId }));
    }

    return attendee;
  }
}

/** A base game and one of its expansions, as one key. */
const linkKey = (baseGameId: string, expansionGameId: string) => `${baseGameId} ${expansionGameId}`;

/**
 * The single add's checks on a collection entry, which the batch offer
 * shares (#1188): it exists, it's the attendee's own, and it isn't removed
 * from their collection, a game they no longer own. An attendee added by
 * name has no collection to check the entry against, so only its existence
 * is checked (#1210).
 */
function judgeCollectionEntry(
  attendee: Pick<EventAttendee, 'userId'>,
  collection: Pick<GameCollection, 'userId' | 'deletedAt'> | null | undefined,
): OfferRefusal | null {
  if (!collection) {
    return OfferRefusal.NotFound;
  }

  if (!attendee.userId) {
    return null;
  }

  if (collection.userId !== attendee.userId) {
    return OfferRefusal.NotInAttendeesCollection;
  }

  return collection.deletedAt ? OfferRefusal.RemovedFromCollection : null;
}

/** The single add's answer to a refusal: the status it always gave. */
function offerRefusalException(reason: OfferRefusal, collectionId: string): HttpException {
  const message = offerRefusalMessage(reason, collectionId);

  switch (reason) {
    case OfferRefusal.NotFound:
      return new NotFoundException(message);
    case OfferRefusal.NotInAttendeesCollection:
      return new ForbiddenException(message);
    default:
      return new BadRequestException(message);
  }
}
