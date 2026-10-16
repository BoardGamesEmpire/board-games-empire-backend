import {
  Action,
  DatabaseService,
  EventAttendee,
  EventAttendeeGameList,
  EventParticipationStatus,
  isPrismaDependentRecordNotFoundError,
  isPrismaUniqueConstraintError,
  Prisma,
  ResourceType,
  SystemRole,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, PermissionsService, ScopeComposer } from '@bge/permissions';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { ACTIVE_NOMINATION_STATUSES, emitSuppliedGameChanges, lineupStillAhead, syncSuppliedGames } from './attendance';
import { AddAttendeeDto } from './dto/add-attendee.dto';
import { AddGameToListDto } from './dto/add-game-to-list.dto';
import { UpdateAttendeeStatusDto } from './dto/update-attendee-status.dto';
import {
  AttendeeAddedEvent,
  AttendeeRemovedEvent,
  AttendeeStatusUpdatedEvent,
  GameAddedToListEvent,
  GameRemovedFromListEvent,
} from './events/attendee.events';
import { assertInvitable } from './invitable';

@Injectable()
export class EventAttendeeService {
  private readonly logger = new Logger(EventAttendeeService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly eventEmitter: EventEmitter2,
    private readonly abilityService: AbilityService,
    private readonly permissions: PermissionsService,
    private readonly scopeComposer: ScopeComposer,
  ) {}

  /**
   * Every attendee of the event the caller may read. The scope is the path's
   * event, composed with the caller's ceiling (#512), without the attendees a
   * host removed (#551). Unpaginated, so no envelope guard checks it; paging
   * it is #373.
   */
  async getAttendees(eventId: string): Promise<EventAttendee[]> {
    await assertEventExists(this.db, eventId);

    return this.db.eventAttendee.findMany({
      where: this.scopeComposer.compose(ResourceType.EventAttendee, Action.read, { eventId, ...NOT_REMOVED }),
      include: ATTENDEE_INCLUDE,
      orderBy: ATTENDEE_ORDER,
    });
  }

  async getAttendee(eventId: string, attendeeId: string): Promise<EventAttendee> {
    await assertEventExists(this.db, eventId);

    const attendee = await this.db.eventAttendee.findUnique({
      where: {
        id: attendeeId,
        eventId,
        ...NOT_REMOVED,
        // eslint-disable-next-line no-restricted-syntax -- single-row fetch by id, not a collection read
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventAttendee, Action.read),
      },
      include: ATTENDEE_INCLUDE,
    });

    if (!attendee) {
      throw new NotFoundException(t('errors.attendee.not_found', { attendeeId, eventId }));
    }

    return attendee;
  }

  async getAttendeeByUserId(eventId: string, userId: string): Promise<EventAttendee> {
    await assertEventExists(this.db, eventId);

    const attendee = await this.db.eventAttendee.findUnique({
      where: {
        eventId_userId: { eventId, userId },
        ...NOT_REMOVED,
        // eslint-disable-next-line no-restricted-syntax -- single-row fetch by its unique (event, user) key, not a collection read
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventAttendee, Action.read),
      },
      include: ATTENDEE_INCLUDE,
    });

    assert(attendee, new NotFoundException(t('errors.attendee.not_found_for_user', { userId, eventId })));
    return attendee;
  }

  async addAttendee(eventId: string, dto: AddAttendeeDto): Promise<EventAttendee> {
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
            include: ATTENDEE_INCLUDE,
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
          include: ATTENDEE_INCLUDE,
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

      return attendee;
    } catch (error) {
      this.logger.error(`Error adding attendee to event ${eventId}`, error);

      if (isPrismaUniqueConstraintError(error) || (removed && isPrismaDependentRecordNotFoundError(error))) {
        throw new ConflictException(t('errors.attendee.already_attendee'));
      }

      throw error;
    }
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
  async removeAttendee(eventId: string, attendeeId: string): Promise<EventAttendee> {
    const initiatedAt = new Date();
    // Attribution guard, not payload data: removal must be performed by a
    // user-attributed actor — system/external actors throw here instead of
    // silently removing attendees. The value itself rides CLS for the audit row.
    this.abilityService.getActingUserId();
    await assertEventExists(this.db, eventId);

    const attendee = await this.db.eventAttendee.findUnique({
      where: { id: attendeeId, eventId, ...NOT_REMOVED },
      select: { id: true, userId: true },
    });

    assert(attendee, new NotFoundException(t('errors.attendee.not_found', { attendeeId, eventId })));

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
          include: ATTENDEE_INCLUDE,
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
          initiatedAt,
        ),
      );
      emitSuppliedGameChanges(this.eventEmitter, eventId, changes, initiatedAt);

      // The event just left this user's ability surface. Without the eviction
      // a removed co-host keeps co-hosting until the cached graph expires.
      await this.permissions.invalidateUser(removed.userId);

      return removed;
    } catch (error) {
      this.logger.error(`Error removing attendee ${attendeeId} from event ${eventId}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('errors.attendee.forbidden_remove'));
      }
      throw error;
    }
  }

  async updateStatus(eventId: string, attendeeId: string, dto: UpdateAttendeeStatusDto): Promise<EventAttendee> {
    const initiatedAt = new Date();
    await assertEventExists(this.db, eventId);

    const existing = await this.db.eventAttendee.findUnique({
      where: { id: attendeeId, eventId, ...NOT_REMOVED },
      select: { id: true, userId: true, status: true },
    });

    if (!existing) {
      throw new NotFoundException(t('errors.attendee.not_found', { attendeeId, eventId }));
    }

    const rsvpDate =
      dto.status === EventParticipationStatus.Attending || dto.status === EventParticipationStatus.NotAttending
        ? new Date()
        : undefined;

    try {
      // Not attending takes the attendee out of the event, and any other
      // answer brings them back in (#551): the games they supply follow, in
      // the same transaction.
      const { updated, changes } = await this.db.$transaction(async (tx) => {
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
          include: ATTENDEE_INCLUDE,
        });

        return { updated, changes: await syncSuppliedGames(tx, updated, initiatedAt) };
      });

      this.eventEmitter.emit(
        AttendeeStatusUpdatedEvent.eventName,
        new AttendeeStatusUpdatedEvent(
          { id: attendeeId, eventId, userId: existing.userId, status: existing.status },
          { id: updated.id, eventId: updated.eventId, userId: updated.userId, status: updated.status },
          initiatedAt,
        ),
      );
      emitSuppliedGameChanges(this.eventEmitter, eventId, changes, initiatedAt);

      return updated;
    } catch (error) {
      this.logger.error(`Error updating status for attendee ${attendeeId} in event ${eventId}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('errors.attendee.forbidden_update'));
      }
      throw error;
    }
  }

  /**
   * The games an attendee has brought to the event, as far as the caller may
   * read them. The scope is the path's attendee, composed with the caller's
   * ceiling (#512), without the games taken off the list (#551). Unpaginated,
   * like `getAttendees`.
   */
  async getGameList(eventId: string, attendeeId: string): Promise<EventAttendeeGameList[]> {
    await assertEventExists(this.db, eventId);
    await this.assertAttendeeExists(eventId, attendeeId);

    return this.db.eventAttendeeGameList.findMany({
      where: this.scopeComposer.compose(ResourceType.EventAttendeeGameList, Action.read, {
        attendeeId,
        ...NOT_REMOVED,
      }),
      include: {
        collection: {
          include: {
            platformGame: {
              select: {
                id: true,

                game: {
                  select: {
                    id: true,
                    title: true,
                    thumbnail: true,
                    minPlayers: true,
                    maxPlayers: true,
                    minPlayTime: true,
                    maxPlayTime: true,
                    complexity: true,
                  },
                },

                platform: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
    });
  }

  async addGameToList(eventId: string, attendeeId: string, dto: AddGameToListDto): Promise<EventAttendeeGameList> {
    const initiatedAt = new Date();
    const event = await requireEvent(this.db, eventId);
    const attendee = await this.assertAttendeeExists(eventId, attendeeId);

    // The route's policy check judges a create by type alone, and `manage`
    // implies `create`: a participant passes it for their own list, a manager
    // for any list in the event. Bind it to the entry about to be written,
    // carrying the attendee's user and event so either grant can match.
    this.abilityService.assertCurrentActorCan(Action.create, ResourceType.EventAttendeeGameList, {
      attendeeId,
      attendee: { id: attendeeId, userId: attendee.userId, eventId, event: { householdId: event.householdId } },
    });

    if (attendee.userId) {
      const collection = await this.db.gameCollection.findUnique({
        where: { id: dto.collectionId },
        select: { userId: true, deletedAt: true },
      });

      assert(
        collection,
        new NotFoundException(t('errors.attendee.game_collection_entry_not_found', { collectionId: dto.collectionId })),
      );
      assert(
        collection.userId === attendee.userId,
        new ForbiddenException(t('errors.attendee.game_from_other_collection')),
      );
      // A tombstoned entry is a game the attendee no longer owns.
      assert(!collection.deletedAt, new BadRequestException(t('errors.attendee.game_removed_from_collection')));
    }

    // A game taken off the list keeps its row, and the (attendee, game) key
    // with it, so putting it back revives that row (#551).
    const removed = await this.db.eventAttendeeGameList.findFirst({
      where: { attendeeId, collectionId: dto.collectionId, removedAt: { not: null } },
      select: { id: true, attendeeId: true, collectionId: true, removedAt: true },
    });

    try {
      const entry = removed
        ? await this.db.eventAttendeeGameList.update({
            // Matches nothing once a concurrent add has revived it, which
            // answers as the duplicate it then is.
            where: { id: removed.id, removedAt: { not: null } },
            data: { removedAt: null },
            include: GAME_LIST_ENTRY_INCLUDE,
          })
        : await this.db.eventAttendeeGameList.create({
            data: {
              attendee: { connect: { id: attendeeId } },
              collection: { connect: { id: dto.collectionId } },
            },
            include: GAME_LIST_ENTRY_INCLUDE,
          });

      this.eventEmitter.emit(
        GameAddedToListEvent.eventName,
        new GameAddedToListEvent(
          removed ?? null,
          { id: entry.id, attendeeId: entry.attendeeId, collectionId: entry.collectionId, removedAt: entry.removedAt },
          eventId,
          initiatedAt,
        ),
      );

      return entry;
    } catch (error) {
      if (isPrismaUniqueConstraintError(error) || (removed && isPrismaDependentRecordNotFoundError(error))) {
        throw new ConflictException(t('errors.attendee.game_already_in_list'));
      }

      this.logger.error(`Error adding game to list for attendee ${attendeeId}`, error);
      throw error;
    }
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
   * (`lockSupplier`) and then finds it removed.
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

/** A list entry as the add serves it: the game and its platform. */
const GAME_LIST_ENTRY_INCLUDE = {
  collection: {
    include: {
      platformGame: {
        select: {
          id: true,

          game: {
            select: {
              id: true,
              title: true,
              thumbnail: true,
            },
          },

          platform: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
  },
} as const satisfies Prisma.EventAttendeeGameListInclude;

// Include object for attendee queries, to ensure consistent user and role data is always fetched
const ATTENDEE_INCLUDE = {
  ...ATTENDEE_USER_AND_ROLE_INCLUDE,
  availableGames: {
    where: NOT_REMOVED,
    include: {
      collection: {
        include: {
          platformGame: {
            select: {
              id: true,

              game: {
                select: {
                  id: true,
                  title: true,
                  thumbnail: true,
                  minPlayers: true,
                  maxPlayers: true,
                  minPlayTime: true,
                  maxPlayTime: true,
                },
              },

              platform: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
      },
    },
  },
} as const satisfies Prisma.EventAttendeeInclude;
