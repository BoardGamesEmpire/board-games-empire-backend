import {
  Action,
  ADD_ON_CONTENT_TYPES,
  ContentType,
  DatabaseService,
  effectiveContentType,
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
import { CodedHttpException, t } from '@bge/i18n';
import type { InviteRevokedEvent } from '@bge/invites';
import { InviteService } from '@bge/invites';
import { LineupRemovalReason } from '@bge/notifications-service';
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
import { Http } from '@status/codes';
import assert from 'node:assert';
import { ATTENDEE_ORDER } from '../constants/attendee-order.constant';
import { ATTENDEE_USER_AND_ROLE_INCLUDE } from '../constants/attendee-user-and-role.constant';
import { LIVE_OFFER } from '../constants/live-offer.constant';
import { NOT_REMOVED } from '../constants/not-removed.constant';
import { assertEventExists, requireEvent } from '../event-access.helpers';
import { OFFERED_GAME_SELECT } from '../offered-game/offered-game.select';
import { OfferedGameService } from '../offered-game/offered-game.service';
import type { OfferedGame, OfferedGameEntry } from '../offered-game/offered-game.types';
import { shareLiveEvent } from '../utils/lock-live-event.util';
import { rsvpDateFor } from '../utils/rsvp-date.util';
import type { AttendeeRow } from './attendance';
import {
  ACTIVE_NOMINATION_STATUSES,
  attendeeAddedEvent,
  emitSuppliedGameChanges,
  lineupStillAhead,
  syncSuppliedGames,
} from './attendance';
import { AddAttendeeDto } from './dto/add-attendee.dto';
import { AddGameToListDto } from './dto/add-game-to-list.dto';
import type { OfferGameItemDto } from './dto/offer-games.dto';
import { OfferGamesDto } from './dto/offer-games.dto';
import { UpdateAttendeeStatusDto } from './dto/update-attendee-status.dto';
import {
  AttendeeAddedEvent,
  AttendeeRemovedEvent,
  AttendeeStatusUpdatedEvent,
  GameAddedToListEvent,
  GameRemovedFromListEvent,
} from './events/attendee.events';
import type { OfferResult } from './offer-outcome';
import { OfferRefusal, offerRefusalMessage } from './offer-outcome';

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
    private readonly invites: InviteService,
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

  /**
   * Adds a person without an account to the event, by name (#742).
   *
   * Someone with an account is invited instead (`POST /events/:eventId/invites`)
   * and becomes an attendee by accepting, so a `userId` answers 400
   * ATTENDEE_ACCOUNT_NEEDS_INVITE before anything is read: one request would
   * otherwise place a user on the event without their consent. The person
   * added has no account to answer with, so they start `Invited` unless the
   * request records their answer.
   */
  async addAttendee(eventId: string, dto: AddAttendeeDto): Promise<AttendeeWithGames> {
    if (dto.userId !== undefined) {
      throw new CodedHttpException(
        Http.BadRequest,
        'ATTENDEE_ACCOUNT_NEEDS_INVITE',
        t('errors.attendee.account_needs_invite'),
      );
    }

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

    if (!dto.guestName) {
      throw new BadRequestException(t('errors.attendee.name_required'));
    }

    const inviter = await this.db.eventAttendee.findUnique({
      where: { eventId_userId: { eventId, userId: invitedByUserId }, ...NOT_REMOVED },
      select: { id: true },
    });

    const status = dto.status ?? EventParticipationStatus.Invited;

    const attendee = await this.db.$transaction(async (tx) => {
      await shareLiveEvent(tx, eventId);

      return tx.eventAttendee.create({
        data: {
          guestName: dto.guestName,
          guestEmail: dto.guestEmail,
          status,
          // Added with an answer, the row holds that answer from now; added
          // as invited, it holds none yet (#1027).
          rsvpDate: rsvpDateFor(status, initiatedAt),
          notes: dto.notes,
          role: { create: { role: { connect: { name: roleName } } } },
          event: { connect: { id: eventId } },
          invitedBy: inviter ? { connect: { id: inviter.id } } : undefined,
        },
        include: ATTENDEE_USER_AND_ROLE_INCLUDE,
      });
    });

    this.eventEmitter.emit(AttendeeAddedEvent.eventName, attendeeAddedEvent(null, attendee, initiatedAt));

    // After the commit: a failure here is the read's, never a duplicate add
    // (#1187).
    return this.withGamesOf(attendee, initiatedAt);
  }

  /**
   * Removes an attendee from the event, keeping their row (#551).
   *
   * The row is marked removed rather than deleted: the nominations and votes
   * it made keep their author, and accepting a new invite revives it (#742).
   * Nothing else that points at the row is touched, so no key into it can
   * refuse the removal. Their role is deleted, which takes every event grant
   * with it, since event grants render only from that role. The invites they
   * sent to the event that are still outstanding are revoked with it, and any
   * still open to them (#742); each is announced after commit. Then they are
   * out of the event, as someone not attending is: the games they supply are
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
      const { removed, revokedInvites, changes } = await this.db.$transaction(async (tx) => {
        await shareLiveEvent(tx, eventId);

        // Read again under the row lock the update takes anyway. A removal
        // that lost a race to another removal answers 404, as one arriving
        // second would. The lock keeps an add from reviving the row (#551)
        // before the update, so a failed update after this read is the grant
        // refusing the removal (#1064).
        const [current] = await tx.$queryRaw<{ removedAt: Date | null }[]>(
          Prisma.sql`SELECT removed_at AS "removedAt" FROM event_attendees WHERE id = ${attendeeId} AND event_id = ${eventId} FOR NO KEY UPDATE`,
        );
        assert(
          current && !current.removedAt,
          new NotFoundException(t('errors.attendee.not_found', { attendeeId, eventId })),
        );

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

        // Their invites end with the standing that sent them (#742), and
        // with them any invite still open to them here, which would let them
        // back in. The lock order, and why it is safe beside an accept, is
        // stated in `shareLiveEvent`.
        const revokedInvites: readonly InviteRevokedEvent[] = removed.userId
          ? (await this.invites.revokeOutstandingOfUserWithin(tx, { eventId }, removed.userId)).events
          : [];

        return { removed, revokedInvites, changes: await syncSuppliedGames(tx, removed, initiatedAt) };
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
      emitSuppliedGameChanges(
        this.eventEmitter,
        eventId,
        changes,
        LineupRemovalReason.SupplierLeft,
        actingUserId,
        initiatedAt,
      );
      this.invites.emit(revokedInvites);

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

    // Notes left out, or sent as null, leave the stored notes as they are:
    // they are unchanged, never cleared (#903).
    const notes = dto.notes ?? undefined;
    let answered: AttendeeRow;

    try {
      // Not attending takes the attendee out of the event, and any other
      // answer brings them back in (#551): the games they supply follow, in
      // the same transaction.
      const { previous, updated, changes, statusChanged, notesChanged } = await this.db.$transaction(async (tx) => {
        await shareLiveEvent(tx, eventId);

        // The status this write replaces, read under the row lock the update
        // takes anyway. The read above runs before the lock, so two RSVPs
        // racing each other would both report the status neither left, and
        // the listener would take the second for an RSVP sent again
        // unchanged and tell nobody (#802). An RSVP that lost a race to the
        // attendee's removal answers 404, as one arriving second would, so a
        // failed update after this read is the grant refusing it (#1064).
        // The status and notes read here are also what the send is compared
        // with, so the second of two identical racing RSVPs is the no-op it
        // is (#903).
        const [previous] = await tx.$queryRaw<
          { notes: string | null; removedAt: Date | null; status: EventParticipationStatus }[]
        >(
          Prisma.sql`SELECT status, notes, removed_at AS "removedAt" FROM event_attendees WHERE id = ${attendeeId} FOR NO KEY UPDATE`,
        );
        assert(
          previous && !previous.removedAt,
          new NotFoundException(t('errors.attendee.not_found', { attendeeId, eventId })),
        );

        const statusChanged = previous.status !== dto.status;
        const notesChanged = notes !== undefined && notes !== previous.notes;

        // The update runs even when nothing changed, so its ceiling still
        // refuses a send the caller may not make, with 403. It writes only
        // the columns that changed: with none, Prisma reads the row through
        // the same where instead of writing it, so `updatedAt` stays put
        // (#903).
        const updated = await tx.eventAttendee.update({
          where: {
            id: attendeeId,
            ...NOT_REMOVED,
            // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
            AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventAttendee, Action.update),
          },
          data: {
            status: statusChanged ? dto.status : undefined,
            notes: notesChanged ? notes : undefined,
            // The date of the current answer moves only when the answer
            // does: a resend or a notes edit leaves it alone, and a move to
            // Invited clears it (#1027).
            rsvpDate: statusChanged ? rsvpDateFor(dto.status, initiatedAt) : undefined,
          },
          include: ATTENDEE_USER_AND_ROLE_INCLUDE,
        });

        return {
          previous,
          updated,
          statusChanged,
          notesChanged,
          changes: await syncSuppliedGames(tx, updated, initiatedAt),
        };
      });

      // A send that changes neither the answer nor the notes is no change,
      // and emits nothing. A notes-only edit is one: its snapshot carries
      // the notes, so the audit entry shows what changed (#903).
      if (statusChanged || notesChanged) {
        this.eventEmitter.emit(
          AttendeeStatusUpdatedEvent.eventName,
          new AttendeeStatusUpdatedEvent(
            {
              id: attendeeId,
              eventId,
              userId: existing.userId,
              status: previous.status,
              ...(notesChanged && { notes: previous.notes }),
            },
            {
              id: updated.id,
              eventId: updated.eventId,
              userId: updated.userId,
              status: updated.status,
              ...(notesChanged && { notes: updated.notes }),
            },
            actingUserId,
            initiatedAt,
          ),
        );
      }

      emitSuppliedGameChanges(
        this.eventEmitter,
        eventId,
        changes,
        LineupRemovalReason.SupplierLeft,
        actingUserId,
        initiatedAt,
      );
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
      { attendeeId, ...LIVE_OFFER, attendee: { is: { eventId, ...NOT_REMOVED } } },
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
   *   from that game to its own, the direction base games are read in, else
   *   `notAnExpansionOfBase`, as is an entry whose platform game is no
   *   add-on on its platform. Its entry must also be on its game's platform,
   *   else `differentPlatform` (#1391). The expansions of a refused game are
   *   refused as `baseRefused`; those of a game already offered go ahead.
   *   For an attendee added by name each expansion is judged as its game
   *   is, so it's `attendeeHasNoCollection` too, or `notFound` (#1210).
   * - An entry already offered is `alreadyOffered`, with its entry, and
   *   emits nothing, before any judgement: nothing is written for it, so
   *   nothing is refused. One taken back earlier comes back with its id.
   *   Two exceptions are judged first. An entry removed from its collection
   *   is refused as `removedFromCollection` even while listed (#1221). For an
   *   attendee added by name every id is judged, so even one already listed
   *   is refused as `attendeeHasNoCollection` (#1210, see below).
   * - The create check runs once, as the single add's, before anything is
   *   read. Every id is judged from three reads, whatever the batch's size.
   * - Each accepted id is its own statement. A write that fails on what
   *   changed since the judgement answers for that id alone (`offerOne`).
   *   Any other database failure fails the request, keeping the entries
   *   written before it; sending the batch again answers those
   *   `alreadyOffered` and offers the rest. Each added entry emits its own
   *   `GameAddedToListEvent`, as the single add does.
   *
   * Like the single add, it refuses every existing entry for an attendee
   * added by name as `attendeeHasNoCollection`, since they have no
   * collection to offer from; that stays until they can claim an account
   * (#488, #1210).
   */
  async offerGames(eventId: string, attendeeId: string, dto: OfferGamesDto): Promise<OfferResult[]> {
    const initiatedAt = new Date();
    const attendee = await this.requireOfferTarget(eventId, attendeeId);
    const named = dto.items.flatMap((item) => [item.collectionId, ...(item.expansionCollectionIds ?? [])]);

    const [collections, listed] = await Promise.all([
      this.db.gameCollection.findMany({
        where: { id: { in: named } },
        select: {
          id: true,
          userId: true,
          deletedAt: true,
          platformGame: {
            select: { gameId: true, platformId: true, contentType: true, game: { select: { contentType: true } } },
          },
        },
      }),
      this.db.eventAttendeeGameList.findMany({
        where: { attendeeId, collectionId: { in: named } },
        select: { ...OFFERED_GAME_SELECT, collectionId: true, removedAt: true },
      }),
    ]);
    const collectionById = new Map(collections.map((collection) => [collection.id, collection]));
    const listedByCollection = new Map(listed.map((entry) => [entry.collectionId, entry]));
    const links = await this.expansionLinks(dto.items, collectionById);

    // Whether an id goes ahead unjudged: an entry already offered and live,
    // which `offerOne` answers `alreadyOffered`, writing nothing. An attendee
    // added by name is judged for every id, even one listed before the rule
    // (#1210). An entry removed from its collection is judged too, so it's
    // refused even while its row is still listed (#1221).
    const goesAheadUnjudged = (collectionId: string) =>
      attendee.userId !== null &&
      listedByCollection.get(collectionId)?.removedAt === null &&
      collectionById.get(collectionId)?.deletedAt === null;

    const judged: { baseId?: string; collectionId: string; refusal: OfferRefusal | null }[] = [];
    for (const item of dto.items) {
      const game = collectionById.get(item.collectionId);
      const gameRefusal = goesAheadUnjudged(item.collectionId) ? null : judgeCollectionEntry(attendee, game);
      judged.push({ collectionId: item.collectionId, refusal: gameRefusal });

      // An attendee added by name has no collection, so each expansion is
      // judged on its own, `attendeeHasNoCollection` or `notFound`, never
      // `baseRefused`, even when its game names no entry (#1210).
      for (const expansionId of item.expansionCollectionIds ?? []) {
        const expansion = collectionById.get(expansionId);
        const refusal = goesAheadUnjudged(expansionId)
          ? null
          : gameRefusal === null
            ? (judgeCollectionEntry(attendee, expansion) ?? judgeExpansionOfBase(game, expansion, links))
            : attendee.userId === null
              ? judgeCollectionEntry(attendee, expansion)
              : OfferRefusal.BaseRefused;
        judged.push({ collectionId: expansionId, baseId: item.collectionId, refusal });
      }
    }

    // One at a time, in request order, each its own statement. A game whose
    // write is refused (its entry deleted since the judgement, as deleting
    // the game does) refuses the expansions still to write with it, as a
    // game refused at judging does, over any reason of their own; one
    // already offered stays so.
    const refusedAtWrite = new Set<string>();
    const settled: (
      | { collectionId: string; refusal: OfferRefusal }
      | { collectionId: string; entry: OfferedGameEntry; outcome: 'added' | 'alreadyOffered' }
    )[] = [];
    for (const { collectionId, baseId, refusal } of judged) {
      const settledRefusal =
        baseId !== undefined && refusedAtWrite.has(baseId) && !goesAheadUnjudged(collectionId)
          ? OfferRefusal.BaseRefused
          : refusal;

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
   * The event's row is locked first (`shareLiveEvent`), which refuses a
   * deleted event (#1065) and holds its dates, so a date write that puts a
   * lineup ahead again either commits first and the game is counted, or
   * waits and then takes the game off itself. The entry is locked
   * `FOR UPDATE` before the check, so a nomination or direct add naming it
   * either commits first and is counted, or waits (`lockSupplier`) and then
   * finds it removed.
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
        await shareLiveEvent(tx, eventId);

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
   * the `GameAddedToListEvent` once it commits. A concurrent add surfaces as
   * Prisma's own error: a unique-key clash on a create, or no row matched on
   * a revive. An event deleted since the caller's read, or its household,
   * answers 404 under the event's row lock (`shareLiveEvent`, #1065).
   */
  private async writeOffer(
    eventId: string,
    attendeeId: string,
    collectionId: string,
    removed: Pick<EventAttendeeGameList, 'id' | 'attendeeId' | 'collectionId' | 'removedAt'> | null,
    initiatedAt: Date,
  ): Promise<OfferedGameEntry> {
    const entry = await this.db.$transaction(async (tx) => {
      await shareLiveEvent(tx, eventId);

      return removed
        ? tx.eventAttendeeGameList.update({
            // Matches nothing once a concurrent add has revived it, which
            // answers as the duplicate it then is.
            where: { id: removed.id, removedAt: { not: null } },
            data: { removedAt: null },
            select: OFFERED_GAME_SELECT,
          })
        : tx.eventAttendeeGameList.create({
            data: {
              attendee: { connect: { id: attendeeId } },
              collection: { connect: { id: collectionId } },
            },
            select: OFFERED_GAME_SELECT,
          });
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
   * An event deleted since, or its household, fails the request with the
   * event's 404, as a request sent after the delete would (#1065). Any other
   * failure is the database's, and fails the request too.
   */
  private async offerOne(
    eventId: string,
    attendeeId: string,
    collectionId: string,
    listed: (OfferedGameEntry & Pick<EventAttendeeGameList, 'collectionId' | 'removedAt'>) | undefined,
    initiatedAt: Date,
  ): Promise<{ entry: OfferedGameEntry; outcome: 'added' | 'alreadyOffered' } | { refusal: OfferRefusal }> {
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
 * name has no collection, so every existing entry is refused as
 * `attendeeHasNoCollection`, after the existence check, and stays so until
 * #488 (#1210).
 */
function judgeCollectionEntry(
  attendee: Pick<EventAttendee, 'userId'>,
  collection: Pick<GameCollection, 'userId' | 'deletedAt'> | null | undefined,
): OfferRefusal | null {
  if (!collection) {
    return OfferRefusal.NotFound;
  }

  if (!attendee.userId) {
    return OfferRefusal.AttendeeHasNoCollection;
  }

  if (collection.userId !== attendee.userId) {
    return OfferRefusal.NotInAttendeesCollection;
  }

  return collection.deletedAt ? OfferRefusal.RemovedFromCollection : null;
}

/**
 * Whether an expansion entry goes with its item's game entry (#1188, #1391):
 * a link from the game to the expansion's own game, and the expansion's
 * platform game an add-on on its platform, else `notAnExpansionOfBase`; and
 * both entries on one platform, else `differentPlatform`. On one platform a
 * link holds there by definition, so those and equal platforms are the whole
 * check. The add-on test reads the platform game's own content type where it
 * has one, as the offered-games filters do, so an entry they count as a base
 * game is never offered as an expansion. An entry that's missing was refused
 * before this.
 */
function judgeExpansionOfBase(
  game: { platformGame: { gameId: string; platformId: string } } | undefined,
  expansion:
    | {
        platformGame: {
          contentType: ContentType | null;
          game: { contentType: ContentType };
          gameId: string;
          platformId: string;
        };
      }
    | undefined,
  links: ReadonlySet<string>,
): OfferRefusal | null {
  if (
    !game ||
    !expansion ||
    !links.has(linkKey(game.platformGame.gameId, expansion.platformGame.gameId)) ||
    !ADD_ON_CONTENT_TYPES.has(
      effectiveContentType(expansion.platformGame.contentType, expansion.platformGame.game.contentType),
    )
  ) {
    return OfferRefusal.NotAnExpansionOfBase;
  }

  return game.platformGame.platformId === expansion.platformGame.platformId ? null : OfferRefusal.DifferentPlatform;
}

/**
 * The single add's answer to a refusal: the status it always gave. The
 * refusal for an attendee added by name also carries the code
 * `ATTENDEE_HAS_NO_COLLECTION`, so a client can tell it from the other 400s
 * (#1210); the older refusals get theirs under #822.
 */
function offerRefusalException(reason: OfferRefusal, collectionId: string): HttpException {
  const message = offerRefusalMessage(reason, collectionId);

  switch (reason) {
    case OfferRefusal.NotFound:
      return new NotFoundException(message);
    case OfferRefusal.NotInAttendeesCollection:
      return new ForbiddenException(message);
    case OfferRefusal.AttendeeHasNoCollection:
      return new CodedHttpException(Http.BadRequest, 'ATTENDEE_HAS_NO_COLLECTION', message);
    default:
      return new BadRequestException(message);
  }
}
