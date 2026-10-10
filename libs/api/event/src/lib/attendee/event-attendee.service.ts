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
import { assertEventExists, requireEvent } from '../event-access.helpers';
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
   * event, composed with the caller's ceiling (#512). Unpaginated, so no
   * envelope guard checks it; paging it is #373.
   */
  async getAttendees(eventId: string): Promise<EventAttendee[]> {
    await assertEventExists(this.db, eventId);

    return this.db.eventAttendee.findMany({
      where: this.scopeComposer.compose(ResourceType.EventAttendee, Action.read, { eventId }),
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
      where: { eventId_userId: { eventId, userId: invitedByUserId } },
      select: { id: true },
    });

    try {
      const attendee = await this.db.eventAttendee.create({
        data: {
          event: { connect: { id: eventId } },
          user: dto.userId ? { connect: { id: dto.userId } } : undefined,
          guestName: dto.guestName,
          guestEmail: dto.guestEmail,
          status: dto.status ?? EventParticipationStatus.Invited,
          notes: dto.notes,
          invitedBy: inviter ? { connect: { id: inviter.id } } : undefined,
          role: {
            create: {
              role: { connect: { name: roleName } },
            },
          },
        },
        include: ATTENDEE_INCLUDE,
      });

      this.eventEmitter.emit(
        AttendeeAddedEvent.eventName,
        new AttendeeAddedEvent(
          {
            id: attendee.id,
            eventId: attendee.eventId,
            userId: attendee.userId,
            guestName: attendee.guestName,
            status: attendee.status,
            invitedById: attendee.invitedById,
          },
          initiatedAt,
        ),
      );

      // The added user's cached graph predates this row, so their role here
      // would otherwise reach them only when the cache expires.
      await this.permissions.invalidateUser(attendee.userId);

      return attendee;
    } catch (error) {
      this.logger.error(`Error adding attendee to event ${eventId}`, error);

      if (isPrismaUniqueConstraintError(error)) {
        throw new ConflictException(t('errors.attendee.already_attendee'));
      }

      throw error;
    }
  }

  async removeAttendee(eventId: string, attendeeId: string): Promise<EventAttendee> {
    const initiatedAt = new Date();
    // Attribution guard, not payload data: removal must be performed by a
    // user-attributed actor — system/external actors throw here instead of
    // silently deleting attendees. The value itself rides CLS for the audit row.
    this.abilityService.getActingUserId();
    await assertEventExists(this.db, eventId);

    const attendee = await this.db.eventAttendee.findUnique({
      where: { id: attendeeId, eventId },
      select: { id: true, userId: true },
    });

    assert(attendee, new NotFoundException(t('errors.attendee.not_found', { attendeeId, eventId })));

    try {
      const deleted = await this.db.eventAttendee.delete({
        where: {
          id: attendeeId,
          // eslint-disable-next-line no-restricted-syntax -- single-row delete by id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventAttendee, Action.delete),
        },
        include: ATTENDEE_INCLUDE,
      });

      this.eventEmitter.emit(
        AttendeeRemovedEvent.eventName,
        new AttendeeRemovedEvent(
          {
            id: deleted.id,
            eventId: deleted.eventId,
            userId: deleted.userId,
            guestName: deleted.guestName,
            status: deleted.status,
          },
          initiatedAt,
        ),
      );

      // The event just left this user's ability surface. Without the eviction
      // a removed co-host keeps co-hosting until the cached graph expires.
      await this.permissions.invalidateUser(deleted.userId);

      return deleted;
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
      where: { id: attendeeId, eventId },
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
      const updated = await this.db.eventAttendee.update({
        where: {
          id: attendeeId,
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

      this.eventEmitter.emit(
        AttendeeStatusUpdatedEvent.eventName,
        new AttendeeStatusUpdatedEvent(
          { id: attendeeId, eventId, userId: existing.userId, status: existing.status },
          { id: updated.id, eventId: updated.eventId, userId: updated.userId, status: updated.status },
          initiatedAt,
        ),
      );

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
   * ceiling (#512). Unpaginated, like `getAttendees`.
   */
  async getGameList(eventId: string, attendeeId: string): Promise<EventAttendeeGameList[]> {
    await assertEventExists(this.db, eventId);
    await this.assertAttendeeExists(eventId, attendeeId);

    return this.db.eventAttendeeGameList.findMany({
      where: this.scopeComposer.compose(ResourceType.EventAttendeeGameList, Action.read, { attendeeId }),
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

    try {
      const entry = await this.db.eventAttendeeGameList.create({
        data: {
          attendee: { connect: { id: attendeeId } },
          collection: { connect: { id: dto.collectionId } },
        },
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

      this.eventEmitter.emit(
        GameAddedToListEvent.eventName,
        new GameAddedToListEvent(
          { id: entry.id, attendeeId: entry.attendeeId, collectionId: entry.collectionId },
          eventId,
          initiatedAt,
        ),
      );

      return entry;
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        throw new ConflictException(t('errors.attendee.game_already_in_list'));
      }

      this.logger.error(`Error adding game to list for attendee ${attendeeId}`, error);
      throw error;
    }
  }

  async removeGameFromList(eventId: string, attendeeId: string, gameListId: string): Promise<EventAttendeeGameList> {
    const initiatedAt = new Date();
    await this.assertAttendeeExists(eventId, attendeeId);

    const entry = await this.db.eventAttendeeGameList.findUnique({
      where: { id: gameListId, attendeeId },
    });

    if (!entry) {
      throw new NotFoundException(t('errors.attendee.game_list_entry_not_found', { gameListId, attendeeId }));
    }

    try {
      const deleted = await this.db.eventAttendeeGameList.delete({
        where: {
          id: gameListId,
          // eslint-disable-next-line no-restricted-syntax -- single-row delete by id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventAttendeeGameList, Action.delete),
        },
      });

      this.eventEmitter.emit(
        GameRemovedFromListEvent.eventName,
        new GameRemovedFromListEvent(
          { id: deleted.id, attendeeId: deleted.attendeeId, collectionId: deleted.collectionId },
          eventId,
          initiatedAt,
        ),
      );

      return deleted;
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
      where: { id: attendeeId, eventId },
      select: { id: true, userId: true },
    });

    if (!attendee) {
      throw new NotFoundException(t('errors.attendee.not_found', { attendeeId, eventId }));
    }

    return attendee;
  }
}

// Include object for attendee queries, to ensure consistent user and role data is always fetched
const ATTENDEE_INCLUDE = {
  ...ATTENDEE_USER_AND_ROLE_INCLUDE,
  availableGames: {
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
