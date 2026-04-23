import {
  DatabaseService,
  EventAttendee,
  EventAttendeeGameList,
  EventParticipationStatus,
  SystemRole,
  isPrismaUniqueConstraintError,
} from '@bge/database';
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
import { AttendeeEvents } from '../attendee/constants';
import { AddAttendeeDto } from './dto/add-attendee.dto';
import { AddGameToListDto } from './dto/add-game-to-list.dto';
import { UpdateAttendeeStatusDto } from './dto/update-attendee-status.dto';
import type {
  AttendeeAddedEvent,
  AttendeeRemovedEvent,
  AttendeeStatusUpdatedEvent,
  GameListUpdatedEvent,
} from './interfaces';

@Injectable()
export class EventAttendeeService {
  private readonly logger = new Logger(EventAttendeeService.name);

  constructor(private readonly db: DatabaseService, private readonly eventEmitter: EventEmitter2) {}

  async getAttendees(eventId: string): Promise<EventAttendee[]> {
    await this.assertEventExists(eventId);

    return this.db.eventAttendee.findMany({
      where: { eventId },
      include: ATTENDEE_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
  }

  async getAttendee(eventId: string, attendeeId: string): Promise<EventAttendee> {
    await this.assertEventExists(eventId);

    const attendee = await this.db.eventAttendee.findUnique({
      where: { id: attendeeId, eventId },
      include: ATTENDEE_INCLUDE,
    });

    if (!attendee) {
      throw new NotFoundException(`Attendee ${attendeeId} not found for event ${eventId}`);
    }

    return attendee;
  }

  async getAttendeeByUserId(eventId: string, userId: string): Promise<EventAttendee> {
    await this.assertEventExists(eventId);

    const attendee = await this.db.eventAttendee.findUnique({
      where: { eventId_userId: { eventId, userId } },
      include: ATTENDEE_INCLUDE,
    });

    assert(attendee, new NotFoundException(`Attendee for user ${userId} not found for event ${eventId}`));
    return attendee;
  }

  async addAttendee(eventId: string, dto: AddAttendeeDto, invitedByUserId: string): Promise<EventAttendee> {
    await this.assertEventExists(eventId);

    if (!dto.userId && !dto.guestName) {
      throw new BadRequestException('Either userId or guestName must be provided.');
    }

    // Resolve the inviter's attendee record (they must be an attendee themselves)
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

      this.eventEmitter.emit(AttendeeEvents.AttendeeAdded, {
        eventId,
        attendeeId: attendee.id,
        userId: dto.userId ?? null,
        guestName: dto.guestName ?? null,
        role: roleName,
        addedById: invitedByUserId,
      } satisfies AttendeeAddedEvent);

      return attendee;
    } catch (error) {
      this.logger.error(`Error adding attendee to event ${eventId}`, error);

      if (isPrismaUniqueConstraintError(error)) {
        throw new ConflictException(`User is already an attendee of this event.`);
      }

      throw error;
    }
  }

  async removeAttendee(eventId: string, attendeeId: string, removedByUserId: string): Promise<EventAttendee> {
    const attendee = await this.db.eventAttendee.findUnique({
      where: { id: attendeeId, eventId },
      select: { id: true, userId: true },
    });

    assert(attendee, new NotFoundException(`Attendee ${attendeeId} not found for event ${eventId}`));

    const deleted = await this.db.eventAttendee.delete({
      where: { id: attendeeId },
      include: ATTENDEE_INCLUDE,
    });

    this.eventEmitter.emit(AttendeeEvents.AttendeeRemoved, {
      eventId,
      attendeeId,
      userId: attendee.userId,
      removedById: removedByUserId,
    } satisfies AttendeeRemovedEvent);

    return deleted;
  }

  async updateStatus(eventId: string, attendeeId: string, dto: UpdateAttendeeStatusDto): Promise<EventAttendee> {
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

    const updated = await this.db.eventAttendee.update({
      where: { id: attendeeId },
      data: {
        status: dto.status,
        notes: dto.notes ?? undefined,
        rsvpDate,
      },
      include: ATTENDEE_INCLUDE,
    });

    this.eventEmitter.emit(AttendeeEvents.AttendeeStatusUpdated, {
      eventId,
      attendeeId,
      userId: existing.userId,
      previousStatus: existing.status,
      newStatus: dto.status,
    } satisfies AttendeeStatusUpdatedEvent);

    return updated;
  }

  async getGameList(eventId: string, attendeeId: string): Promise<EventAttendeeGameList[]> {
    await this.assertAttendeeExists(eventId, attendeeId);

    return this.db.eventAttendeeGameList.findMany({
      where: { attendeeId },
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
    const attendee = await this.assertAttendeeExists(eventId, attendeeId);

    // Validate that the collection entry belongs to the attendee's user
    if (attendee.userId) {
      const collection = await this.db.gameCollection.findUnique({
        where: { id: dto.collectionId },
        select: { userId: true },
      });

      if (!collection) {
        throw new NotFoundException(`Game collection entry ${dto.collectionId} not found.`);
      }

      if (collection.userId !== attendee.userId) {
        throw new ForbiddenException("Cannot add a game from another user's collection.");
      }
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

      this.eventEmitter.emit(AttendeeEvents.GameListUpdated, {
        eventId,
        attendeeId,
        userId: attendee.userId,
        action: 'added',
        collectionId: dto.collectionId,
      } satisfies GameListUpdatedEvent);

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
    const attendee = await this.assertAttendeeExists(eventId, attendeeId);

    const entry = await this.db.eventAttendeeGameList.findUnique({
      where: { id: gameListId, attendeeId },
    });

    if (!entry) {
      throw new NotFoundException(`Game list entry ${gameListId} not found for attendee ${attendeeId}.`);
    }

    const deleted = await this.db.eventAttendeeGameList.delete({
      where: { id: gameListId },
    });

    this.eventEmitter.emit(AttendeeEvents.GameListUpdated, {
      eventId,
      attendeeId,
      userId: attendee.userId,
      action: 'removed',
      collectionId: entry.collectionId,
    } satisfies GameListUpdatedEvent);

    return deleted;
  }

  private async assertEventExists(eventId: string): Promise<void> {
    const count = await this.db.event.count({
      where: { id: eventId, deletedAt: null },
    });
    assert(count > 0, new NotFoundException(`Event ${eventId} not found`));
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
