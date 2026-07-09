import {
  Action,
  DatabaseService,
  EventAttendee,
  EventAttendeeGameList,
  EventParticipationStatus,
  isPrismaDependentRecordNotFoundError,
  isPrismaUniqueConstraintError,
  ResourceType,
  SystemRole,
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
import { EventEmitter2 } from '@nestjs/event-emitter';
import assert from 'node:assert';
import { assertEventExists } from '../event-access.helpers';
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
  ) {}

  async getAttendees(eventId: string): Promise<EventAttendee[]> {
    await assertEventExists(this.db, eventId);

    return this.db.eventAttendee.findMany({
      where: {
        eventId,
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventAttendee, Action.read),
      },
      include: ATTENDEE_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
  }

  async getAttendee(eventId: string, attendeeId: string): Promise<EventAttendee> {
    await assertEventExists(this.db, eventId);

    const attendee = await this.db.eventAttendee.findUnique({
      where: {
        id: attendeeId,
        eventId,
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventAttendee, Action.read),
      },
      include: ATTENDEE_INCLUDE,
    });

    if (!attendee) {
      throw new NotFoundException(`Attendee ${attendeeId} not found for event ${eventId}`);
    }

    return attendee;
  }

  async getAttendeeByUserId(eventId: string, userId: string): Promise<EventAttendee> {
    await assertEventExists(this.db, eventId);

    const attendee = await this.db.eventAttendee.findUnique({
      where: {
        eventId_userId: { eventId, userId },
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventAttendee, Action.read),
      },
      include: ATTENDEE_INCLUDE,
    });

    assert(attendee, new NotFoundException(`Attendee for user ${userId} not found for event ${eventId}`));
    return attendee;
  }

  async addAttendee(eventId: string, dto: AddAttendeeDto): Promise<EventAttendee> {
    const initiatedAt = new Date();
    await assertEventExists(this.db, eventId);
    const invitedByUserId = this.abilityService.getActingUserId();

    if (!dto.userId && !dto.guestName) {
      throw new BadRequestException('Either userId or guestName must be provided.');
    }

    const inviter = await this.db.eventAttendee.findUnique({
      where: { eventId_userId: { eventId, userId: invitedByUserId } },
      select: { id: true },
    });

    const roleName = dto.role ?? SystemRole.EventParticipant;

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

      return attendee;
    } catch (error) {
      this.logger.error(`Error adding attendee to event ${eventId}`, error);

      if (isPrismaUniqueConstraintError(error)) {
        throw new ConflictException(`User is already an attendee of this event.`);
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

    assert(attendee, new NotFoundException(`Attendee ${attendeeId} not found for event ${eventId}`));

    try {
      const deleted = await this.db.eventAttendee.delete({
        where: {
          id: attendeeId,
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventAttendee, Action.manage),
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

      return deleted;
    } catch (error) {
      this.logger.error(`Error removing attendee ${attendeeId} from event ${eventId}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException("You don't have permission to remove this attendee.");
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
      throw new NotFoundException(`Attendee ${attendeeId} not found for event ${eventId}`);
    }

    const rsvpDate =
      dto.status === EventParticipationStatus.Attending || dto.status === EventParticipationStatus.NotAttending
        ? new Date()
        : undefined;

    try {
      const updated = await this.db.eventAttendee.update({
        where: {
          id: attendeeId,
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
        throw new ForbiddenException("You don't have permission to update this attendee.");
      }
      throw error;
    }
  }

  async getGameList(eventId: string, attendeeId: string): Promise<EventAttendeeGameList[]> {
    await assertEventExists(this.db, eventId);
    await this.assertAttendeeExists(eventId, attendeeId);

    return this.db.eventAttendeeGameList.findMany({
      where: {
        attendeeId,
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventAttendeeGameList, Action.read),
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
    await assertEventExists(this.db, eventId);
    const attendee = await this.assertAttendeeExists(eventId, attendeeId);

    if (attendee.userId) {
      const collection = await this.db.gameCollection.findUnique({
        where: { id: dto.collectionId },
        select: { userId: true, deletedAt: true },
      });

      assert(collection, new NotFoundException(`Game collection entry ${dto.collectionId} not found.`));
      assert(
        collection.userId === attendee.userId,
        new ForbiddenException("Cannot add a game from another user's collection."),
      );
      // A tombstoned entry is a game the attendee no longer owns.
      assert(
        !collection.deletedAt,
        new BadRequestException('Cannot add a game that has been removed from the collection.'),
      );
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
        throw new ConflictException("This game is already in the attendee's list.");
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
      throw new NotFoundException(`Game list entry ${gameListId} not found for attendee ${attendeeId}.`);
    }

    try {
      const deleted = await this.db.eventAttendeeGameList.delete({
        where: {
          id: gameListId,
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
        throw new ForbiddenException("You don't have permission to remove this game.");
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
      throw new NotFoundException(`Attendee ${attendeeId} not found for event ${eventId}`);
    }

    return attendee;
  }
}

// Include object for attendee queries, to ensure consistent user and role data is always fetched
const ATTENDEE_INCLUDE = {
  user: {
    select: {
      id: true,
      username: true,
      profile: {
        select: {
          avatarUrl: true,
          displayName: true,
        },
      },
    },
  },
  role: {
    include: {
      role: {
        select: { id: true, name: true },
      },
    },
  },
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
} as const;
