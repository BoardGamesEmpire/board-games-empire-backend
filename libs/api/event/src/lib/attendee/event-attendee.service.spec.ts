import {
  EventAttendee,
  EventAttendeeGameList,
  EventParticipationStatus,
  GameCollection,
  Prisma,
  SystemRole,
} from '@bge/database';
import { createTestingModuleWithDb, makeEventAttendee, MockDatabaseService } from '@bge/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaError } from '@status/codes';
import { AttendeeEvents } from './constants';
import { AddAttendeeDto } from './dto/add-attendee.dto';
import { UpdateAttendeeStatusDto } from './dto/update-attendee-status.dto';
import { EventAttendeeService } from './event-attendee.service';
import type {
  AttendeeAddedEvent,
  AttendeeRemovedEvent,
  AttendeeStatusUpdatedEvent,
  GameListUpdatedEvent,
} from './interfaces';

describe('EventAttendeeService', () => {
  let service: EventAttendeeService;
  let db: MockDatabaseService;
  let eventEmitter: jest.Mocked<Pick<EventEmitter2, 'emit'>>;

  beforeEach(async () => {
    eventEmitter = { emit: jest.fn() };

    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [EventAttendeeService, { provide: EventEmitter2, useValue: eventEmitter }],
    });

    service = module.get(EventAttendeeService);
    db = mockDb;
  });

  afterEach(() => jest.clearAllMocks());

  describe('getAttendees', () => {
    it('returns all attendees for an event', async () => {
      stubEventExists(db);
      const attendees = [stubAttendee(), stubAttendee({ userId: 'user-2' })];
      db.eventAttendee.findMany.mockResolvedValue(attendees);

      const result = await service.getAttendees('event-1');

      expect(db.eventAttendee.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { eventId: 'event-1' },
          orderBy: { createdAt: 'asc' },
        }),
      );

      expect(result).toHaveLength(2);
    });

    it('throws NotFoundException when event does not exist', async () => {
      stubEventExists(db, false);

      await expect(service.getAttendees('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getAttendee', () => {
    it('returns a single attendee with includes', async () => {
      stubEventExists(db);
      const attendee = stubAttendee({ id: 'att-1' });
      db.eventAttendee.findUnique.mockResolvedValue(attendee);

      const result = await service.getAttendee('event-1', 'att-1');

      expect(db.eventAttendee.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'att-1', eventId: 'event-1' },
        }),
      );

      expect(result).toBe(attendee);
    });

    it('throws NotFoundException when attendee does not exist', async () => {
      stubEventExists(db);
      db.eventAttendee.findUnique.mockResolvedValue(null);

      await expect(service.getAttendee('event-1', 'nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('addAttendee', () => {
    it('creates a registered user attendee with role', async () => {
      stubEventExists(db);
      const created = stubAttendee({ id: 'att-new' });
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'inviter-1' } as EventAttendee); // inviter lookup
      db.eventAttendee.create.mockResolvedValue(created);

      const dto: AddAttendeeDto = { userId: 'user-2' };
      const result = await service.addAttendee('event-1', dto, 'user-1');

      expect(db.eventAttendee.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            event: { connect: { id: 'event-1' } },
            user: { connect: { id: 'user-2' } },
            status: EventParticipationStatus.Invited,
            role: expect.objectContaining({
              create: expect.objectContaining({
                role: { connect: { name: SystemRole.EventParticipant } },
              }),
            }),
          }),
        }),
      );

      expect(result).toBe(created);
    });

    it('creates a guest attendee without userId', async () => {
      stubEventExists(db);
      const created = stubAttendee({ id: 'att-guest', userId: null });
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'inviter-1' } as EventAttendee);
      db.eventAttendee.create.mockResolvedValue(created);

      const dto: AddAttendeeDto = {
        guestName: 'Alice',
        guestEmail: 'alice@example.com',
      };
      const result = await service.addAttendee('event-1', dto, 'user-1');

      expect(db.eventAttendee.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            user: undefined,
            guestName: 'Alice',
            guestEmail: 'alice@example.com',
          }),
        }),
      );

      expect(result).toBe(created);
    });

    it('uses the specified role when provided', async () => {
      stubEventExists(db);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'inviter-1' } as EventAttendee);
      db.eventAttendee.create.mockResolvedValue(stubAttendee());

      const dto: AddAttendeeDto = {
        userId: 'user-2',
        role: SystemRole.EventCoHost,
      };
      await service.addAttendee('event-1', dto, 'user-1');

      expect(db.eventAttendee.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            role: expect.objectContaining({
              create: expect.objectContaining({
                role: { connect: { name: SystemRole.EventCoHost } },
              }),
            }),
          }),
        }),
      );
    });

    it('emits AttendeeAdded domain event', async () => {
      stubEventExists(db);
      const created = stubAttendee({ id: 'att-emit' });
      db.eventAttendee.findUnique.mockResolvedValue(null); // no inviter record
      db.eventAttendee.create.mockResolvedValue(created);

      await service.addAttendee('event-1', { userId: 'user-3' }, 'user-1');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        AttendeeEvents.AttendeeAdded,
        expect.objectContaining({
          eventId: 'event-1',
          attendeeId: 'att-emit',
          userId: 'user-3',
          addedById: 'user-1',
          role: SystemRole.EventParticipant,
        } satisfies AttendeeAddedEvent),
      );
    });

    it('throws BadRequestException when neither userId nor guestName provided', async () => {
      stubEventExists(db);

      await expect(service.addAttendee('event-1', {}, 'user-1')).rejects.toThrow(BadRequestException);
    });

    it('throws ConflictException on duplicate attendee', async () => {
      stubEventExists(db);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'inviter-1' } as EventAttendee);

      const prismaError = new Prisma.PrismaClientKnownRequestError('', {
        code: PrismaError.UniqueConstraintViolation,
        clientVersion: '0',
      });
      db.eventAttendee.create.mockRejectedValue(prismaError);

      await expect(service.addAttendee('event-1', { userId: 'user-2' }, 'user-1')).rejects.toThrow(ConflictException);
    });

    it('throws NotFoundException when event does not exist', async () => {
      stubEventExists(db, false);

      await expect(service.addAttendee('nonexistent', { userId: 'user-2' }, 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('removeAttendee', () => {
    it('deletes the attendee and emits domain event', async () => {
      const attendee = stubAttendee({ id: 'att-del' });
      db.eventAttendee.findUnique.mockResolvedValue({
        id: 'att-del',
        userId: 'user-2',
      } as EventAttendee);
      db.eventAttendee.delete.mockResolvedValue(attendee);

      const result = await service.removeAttendee('event-1', 'att-del', 'user-1');

      expect(db.eventAttendee.delete).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'att-del' } }));
      expect(result).toBe(attendee);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        AttendeeEvents.AttendeeRemoved,
        expect.objectContaining({
          eventId: 'event-1',
          attendeeId: 'att-del',
          userId: 'user-2',
          removedById: 'user-1',
        } satisfies AttendeeRemovedEvent),
      );
    });

    it('throws NotFoundException when attendee does not exist', async () => {
      db.eventAttendee.findUnique.mockResolvedValue(null);

      await expect(service.removeAttendee('event-1', 'nonexistent', 'user-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateStatus', () => {
    it('updates status and sets rsvpDate for Attending', async () => {
      db.eventAttendee.findUnique.mockResolvedValue({
        id: 'att-1',
        userId: 'user-1',
        status: EventParticipationStatus.Invited,
      } as EventAttendee);
      const updated = stubAttendee({ status: EventParticipationStatus.Attending });
      db.eventAttendee.update.mockResolvedValue(updated);

      const dto: UpdateAttendeeStatusDto = {
        status: EventParticipationStatus.Attending,
      };

      const result = await service.updateStatus('event-1', 'att-1', dto);
      expect(db.eventAttendee.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: EventParticipationStatus.Attending,
            rsvpDate: expect.any(Date),
          }),
        }),
      );

      expect(result).toBe(updated);
    });

    it('does not set rsvpDate for Maybe status', async () => {
      db.eventAttendee.findUnique.mockResolvedValue({
        id: 'att-1',
        userId: 'user-1',
        status: EventParticipationStatus.Invited,
      } as EventAttendee);
      db.eventAttendee.update.mockResolvedValue(stubAttendee());

      const dto: UpdateAttendeeStatusDto = {
        status: EventParticipationStatus.Maybe,
      };
      await service.updateStatus('event-1', 'att-1', dto);

      expect(db.eventAttendee.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rsvpDate: undefined,
          }),
        }),
      );
    });

    it('emits AttendeeStatusUpdated with previous and new status', async () => {
      db.eventAttendee.findUnique.mockResolvedValue({
        id: 'att-1',
        userId: 'user-1',
        status: EventParticipationStatus.Invited,
      } as EventAttendee);
      db.eventAttendee.update.mockResolvedValue(stubAttendee());

      await service.updateStatus('event-1', 'att-1', {
        status: EventParticipationStatus.Attending,
      });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        AttendeeEvents.AttendeeStatusUpdated,
        expect.objectContaining({
          eventId: 'event-1',
          attendeeId: 'att-1',
          userId: 'user-1',
          previousStatus: EventParticipationStatus.Invited,
          newStatus: EventParticipationStatus.Attending,
        } satisfies AttendeeStatusUpdatedEvent),
      );
    });

    it('throws NotFoundException when attendee does not exist', async () => {
      db.eventAttendee.findUnique.mockResolvedValue(null);

      await expect(
        service.updateStatus('event-1', 'nonexistent', {
          status: EventParticipationStatus.Attending,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getGameList', () => {
    it('returns game list entries for the attendee', async () => {
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      const entries = [{ id: 'gl-1' }, { id: 'gl-2' }] as EventAttendeeGameList[];
      db.eventAttendeeGameList.findMany.mockResolvedValue(entries);

      const result = await service.getGameList('event-1', 'att-1');

      expect(db.eventAttendeeGameList.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { attendeeId: 'att-1' } }),
      );

      expect(result).toHaveLength(2);
    });

    it('throws NotFoundException when attendee does not exist', async () => {
      db.eventAttendee.findUnique.mockResolvedValue(null);

      await expect(service.getGameList('event-1', 'nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('addGameToList', () => {
    it('creates a game list entry and emits domain event', async () => {
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      db.gameCollection.findUnique.mockResolvedValue({ userId: 'user-1' } as GameCollection);
      const created = { id: 'gl-new', attendeeId: 'att-1', collectionId: 'gc-1' } as EventAttendeeGameList;
      db.eventAttendeeGameList.create.mockResolvedValue(created);

      const result = await service.addGameToList('event-1', 'att-1', {
        collectionId: 'gc-1',
      });

      expect(db.eventAttendeeGameList.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            attendee: { connect: { id: 'att-1' } },
            collection: { connect: { id: 'gc-1' } },
          }),
        }),
      );

      expect(result).toBe(created);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        AttendeeEvents.GameListUpdated,
        expect.objectContaining({
          eventId: 'event-1',
          attendeeId: 'att-1',
          action: 'added',
          userId: 'user-1',
          collectionId: 'gc-1',
        } satisfies GameListUpdatedEvent),
      );
    });

    it('throws ForbiddenException when collection belongs to another user', async () => {
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      db.gameCollection.findUnique.mockResolvedValue({ userId: 'user-other' } as GameCollection);

      await expect(service.addGameToList('event-1', 'att-1', { collectionId: 'gc-stolen' })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws NotFoundException when collection does not exist', async () => {
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      db.gameCollection.findUnique.mockResolvedValue(null);

      await expect(service.addGameToList('event-1', 'att-1', { collectionId: 'gc-missing' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ConflictException on duplicate game list entry', async () => {
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      db.gameCollection.findUnique.mockResolvedValue({ userId: 'user-1' } as GameCollection);

      const prismaError = new Prisma.PrismaClientKnownRequestError('', {
        code: PrismaError.UniqueConstraintViolation,
        clientVersion: '0',
      });
      db.eventAttendeeGameList.create.mockRejectedValue(prismaError);

      await expect(service.addGameToList('event-1', 'att-1', { collectionId: 'gc-dup' })).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('removeGameFromList', () => {
    it('deletes the entry and emits domain event', async () => {
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      db.eventAttendeeGameList.findUnique.mockResolvedValue({
        id: 'gl-1',
        attendeeId: 'att-1',
        collectionId: 'gc-1',
      } as EventAttendeeGameList);
      const deleted = { id: 'gl-1' } as EventAttendeeGameList;
      db.eventAttendeeGameList.delete.mockResolvedValue(deleted);

      const result = await service.removeGameFromList('event-1', 'att-1', 'gl-1');

      expect(db.eventAttendeeGameList.delete).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'gl-1' } }));
      expect(result).toBe(deleted);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        AttendeeEvents.GameListUpdated,
        expect.objectContaining({
          action: 'removed',
          collectionId: 'gc-1',
        } satisfies Partial<GameListUpdatedEvent>),
      );
    });

    it('throws NotFoundException when game list entry does not exist', async () => {
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      db.eventAttendeeGameList.findUnique.mockResolvedValue(null);

      await expect(service.removeGameFromList('event-1', 'att-1', 'gl-missing')).rejects.toThrow(NotFoundException);
    });
  });
});

function stubAttendee(overrides: Partial<EventAttendee> = {}): EventAttendee {
  return makeEventAttendee({
    eventId: 'event-1',
    userId: 'user-1',
    ...overrides,
  });
}

function stubEventExists(db: MockDatabaseService, exists = true): void {
  db.event.count.mockResolvedValue(exists ? 1 : 0);
}
