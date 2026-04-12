import {
  Action,
  Event,
  EventParticipationStatus,
  EventSchedulingMode,
  GameAdditionMode,
  OccurrenceStatus,
  Prisma,
  SystemRole,
} from '@bge/database';
import type { AppAbility } from '@bge/permissions';
import { createTestingModuleWithDb, makeEvent, MockDatabaseService } from '@bge/testing';
import { createPrismaAbility } from '@casl/prisma';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaError } from '@status/codes';
import { DateTime } from 'luxon';
import { EventEvents } from './constants/event-events.constant';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { EventService } from './event.service';
import type { EventCreatedEvent, EventDeletedEvent } from './interfaces/event.interface';

describe('EventService', () => {
  let service: EventService;
  let db: MockDatabaseService;
  let eventEmitter: jest.Mocked<Pick<EventEmitter2, 'emit'>>;

  // An allow-all ability so accessibleBy() produces a valid (empty) WHERE clause
  // rather than throwing. The Prisma mock ignores the generated WHERE entirely.
  const userAbility = createPrismaAbility([{ action: Action.manage, subject: 'all' }]) as AppAbility;

  beforeEach(async () => {
    eventEmitter = { emit: jest.fn() };

    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [EventService, { provide: EventEmitter2, useValue: eventEmitter }],
    });

    service = module.get(EventService);
    db = mockDb;
  });

  afterEach(() => jest.clearAllMocks());

  describe('getEvents', () => {
    it('returns paginated events excluding soft-deleted records', async () => {
      const events = [stubEventFixture(), stubEventFixture({ title: 'Second Night' })];
      db.event.findMany.mockResolvedValue(events);

      const result = await service.getEvents({ limit: 10, offset: 0 }, [userAbility]);

      expect(db.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ deletedAt: null }),
          skip: 0,
          take: 10,
        }),
      );

      expect(result).toHaveLength(2);
    });

    it('defaults to 20 when limit is not provided', async () => {
      db.event.findMany.mockResolvedValue([]);

      await service.getEvents({ limit: NaN, offset: 0 }, [userAbility]);

      expect(db.event.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 20 }));
    });
  });

  describe('getEventById', () => {
    it('returns the event with attendees and occurrences included', async () => {
      const event = stubEventFixture();
      db.event.findUnique.mockResolvedValue(event);

      const result = await service.getEventById('event-1', [userAbility]);

      expect(db.event.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'event-1', deletedAt: null }),
          include: expect.objectContaining({
            attendees: expect.any(Object),
            occurrences: expect.any(Object),
            policy: true,
          }),
        }),
      );

      expect(result).toBe(event);
    });

    it('throws NotFoundException when event does not exist', async () => {
      db.event.findUnique.mockResolvedValue(null);

      await expect(service.getEventById('nonexistent', [userAbility])).rejects.toThrow(NotFoundException);
    });
  });

  describe('createEvent', () => {
    it('creates an event with occurrences and policy inside a transaction', async () => {
      const createdEvent = stubEventFixture({ id: 'new-event-1' });

      // $transaction receives a callback; we invoke it with a mock tx
      // that behaves the same as the top-level db mock.
      db.$transaction.mockImplementation((cb) => cb(db));
      db.event.create.mockResolvedValue(createdEvent);

      const dto = makeCreateDto({
        householdId: 'household-1',
        schedulingMode: EventSchedulingMode.Fixed,
        occurrences: [
          {
            label: 'Evening Session',
            startDate: DateTime.now().plus({ days: 7 }).toJSDate(),
            endDate: DateTime.now().plus({ days: 7, hours: 4 }).toJSDate(),
          },
        ],
        policy: {
          allowMemberInvites: true,
          gameAdditionMode: GameAdditionMode.Direct,
        },
      });

      const result = await service.createEvent('user-1', dto);

      expect(db.$transaction).toHaveBeenCalledTimes(1);
      expect(db.event.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            title: 'Board Game Night',
            household: { connect: { id: 'household-1' } },
            createdBy: { connect: { id: 'user-1' } },
            occurrences: expect.objectContaining({
              create: expect.arrayContaining([
                expect.objectContaining({
                  label: 'Evening Session',
                  status: OccurrenceStatus.Confirmed,
                }),
              ]),
            }),

            attendees: expect.objectContaining({
              create: expect.arrayContaining([
                expect.objectContaining({
                  user: { connect: { id: 'user-1' } },
                  status: EventParticipationStatus.Attending,
                  role: expect.objectContaining({
                    create: expect.objectContaining({
                      role: { connect: { name: SystemRole.EventHost } },
                    }),
                  }),
                }),
              ]),
            }),
          }),
        }),
      );

      expect(result).toBe(createdEvent);
    });

    it('creates an event without householdId (venue-based event)', async () => {
      const createdEvent = stubEventFixture({ id: 'venue-event-1' });
      db.$transaction.mockImplementation((cb) => cb(db));
      db.event.create.mockResolvedValue(createdEvent);

      const dto = makeCreateDto({ location: 'Friendly Local Game Store' });

      await service.createEvent('user-1', dto);

      expect(db.event.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            household: undefined,
          }),
        }),
      );
    });

    it('sets occurrence status to Proposed for Poll scheduling mode', async () => {
      const createdEvent = stubEventFixture();
      db.$transaction.mockImplementation((cb) => cb(db));
      db.event.create.mockResolvedValue(createdEvent);

      const dto = makeCreateDto({
        schedulingMode: EventSchedulingMode.Poll,
        occurrences: [
          { startDate: DateTime.now().plus({ days: 7 }).toJSDate() },
          { startDate: DateTime.now().plus({ days: 8 }).toJSDate() },
        ],
      });

      await service.createEvent('user-1', dto);

      const createCall = db.event.create.mock.calls[0][0] as {
        data: { occurrences: { create: Array<{ status: OccurrenceStatus }> } };
      };
      const occurrenceCreates = createCall.data.occurrences.create;

      expect(occurrenceCreates).toHaveLength(2);
      expect(occurrenceCreates[0].status).toBe(OccurrenceStatus.Proposed);
      expect(occurrenceCreates[1].status).toBe(OccurrenceStatus.Proposed);
    });

    it('throws BadRequestException when Fixed mode has more than one occurrence', async () => {
      const dto = makeCreateDto({
        schedulingMode: EventSchedulingMode.Fixed,
        occurrences: [
          { startDate: DateTime.now().plus({ days: 7 }).toJSDate() },
          { startDate: DateTime.now().plus({ days: 8 }).toJSDate() },
        ],
      });

      await expect(service.createEvent('user-1', dto)).rejects.toThrow(BadRequestException);
    });

    it('emits an EventCreated domain event after successful creation', async () => {
      const createdEvent = stubEventFixture({
        id: 'emitted-event-1',
        title: 'Strategy Night',
      });
      db.$transaction.mockImplementation((cb) => cb(db));
      db.event.create.mockResolvedValue(createdEvent);

      await service.createEvent('user-1', makeCreateDto({ householdId: 'hh-1', title: 'Strategy Night' }));

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EventEvents.EventCreated,
        expect.objectContaining({
          eventId: 'emitted-event-1',
          createdById: 'user-1',
          householdId: 'hh-1',
          title: 'Strategy Night',
          invitedUserIds: [],
        } satisfies EventCreatedEvent),
      );
    });

    it('emits EventCreated with null householdId for venue-based events', async () => {
      const createdEvent = stubEventFixture({ id: 'venue-1' });
      db.$transaction.mockImplementation((cb) => cb(db));
      db.event.create.mockResolvedValue(createdEvent);

      await service.createEvent('user-1', makeCreateDto());

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EventEvents.EventCreated,
        expect.objectContaining({ householdId: null }),
      );
    });

    it('creates event without occurrences when none are provided', async () => {
      const createdEvent = stubEventFixture();
      db.$transaction.mockImplementation((cb) => cb(db));
      db.event.create.mockResolvedValue(createdEvent);

      await service.createEvent('user-1', makeCreateDto());

      expect(db.event.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            occurrences: undefined,
          }),
        }),
      );
    });

    it('creates attendee records for invited users as EventParticipant with Invited status', async () => {
      const createdEvent = stubEventFixture({ id: 'invite-event-1' });
      db.$transaction.mockImplementation((cb) => cb(db));
      db.event.create.mockResolvedValue(createdEvent);

      const dto = makeCreateDto({
        inviteUserIds: ['user-friend-1', 'user-friend-2'],
      });

      await service.createEvent('user-1', dto);

      const createCall = db.event.create.mock.calls[0][0] as {
        data: {
          attendees: {
            create: Array<{
              user: { connect: { id: string } };
              status: string;
              role: { create: { role: { connect: { name: string } } } };
            }>;
          };
        };
      };
      const attendeeCreates = createCall.data.attendees.create;

      // Host + 2 invitees = 3 records
      expect(attendeeCreates).toHaveLength(3);

      // First is always the host
      expect(attendeeCreates[0]).toEqual(
        expect.objectContaining({
          user: { connect: { id: 'user-1' } },
          status: 'Attending',
          role: expect.objectContaining({
            create: expect.objectContaining({
              role: { connect: { name: SystemRole.EventHost } },
            }),
          }),
        }),
      );

      // Invitees are EventParticipant with Invited status
      expect(attendeeCreates[1]).toEqual(
        expect.objectContaining({
          user: { connect: { id: 'user-friend-1' } },
          status: 'Invited',
          role: expect.objectContaining({
            create: expect.objectContaining({
              role: { connect: { name: SystemRole.EventParticipant } },
            }),
          }),
        }),
      );
      expect(attendeeCreates[2]).toEqual(
        expect.objectContaining({
          user: { connect: { id: 'user-friend-2' } },
          status: 'Invited',
        }),
      );
    });

    it('excludes the creator from inviteUserIds to avoid duplicate attendee', async () => {
      const createdEvent = stubEventFixture();
      db.$transaction.mockImplementation((cb) => cb(db));
      db.event.create.mockResolvedValue(createdEvent);

      const dto = makeCreateDto({
        inviteUserIds: ['user-1', 'user-friend-1'], // user-1 is the creator
      });

      await service.createEvent('user-1', dto);

      const createCall = db.event.create.mock.calls[0][0] as {
        data: { attendees: { create: Array<{ user: { connect: { id: string } } }> } };
      };
      const attendeeCreates = createCall.data.attendees.create;

      // Only host + 1 friend (creator filtered out)
      expect(attendeeCreates).toHaveLength(2);
      expect(attendeeCreates.map((a) => a.user.connect.id)).toEqual(['user-1', 'user-friend-1']);
    });

    it('deduplicates inviteUserIds', async () => {
      const createdEvent = stubEventFixture();
      db.$transaction.mockImplementation((cb) => cb(db));
      db.event.create.mockResolvedValue(createdEvent);

      const dto = makeCreateDto({
        inviteUserIds: ['user-friend-1', 'user-friend-1', 'user-friend-2'],
      });

      await service.createEvent('user-1', dto);

      const createCall = db.event.create.mock.calls[0][0] as {
        data: { attendees: { create: Array<{ user: { connect: { id: string } } }> } };
      };
      const attendeeCreates = createCall.data.attendees.create;

      // Host + 2 unique friends
      expect(attendeeCreates).toHaveLength(3);
    });

    it('emits EventCreated with the deduplicated invitedUserIds', async () => {
      const createdEvent = stubEventFixture({ id: 'invite-emit-1' });
      db.$transaction.mockImplementation((cb) => cb(db));
      db.event.create.mockResolvedValue(createdEvent);

      const dto = makeCreateDto({
        inviteUserIds: ['user-1', 'user-friend-1', 'user-friend-1'],
      });

      await service.createEvent('user-1', dto);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EventEvents.EventCreated,
        expect.objectContaining({
          invitedUserIds: ['user-friend-1'], // creator removed, duplicate removed
        }),
      );
    });

    it('creates only the host attendee when inviteUserIds is empty', async () => {
      const createdEvent = stubEventFixture();
      db.$transaction.mockImplementation((cb) => cb(db));
      db.event.create.mockResolvedValue(createdEvent);

      const dto = makeCreateDto({ inviteUserIds: [] });

      await service.createEvent('user-1', dto);

      const createCall = db.event.create.mock.calls[0][0] as {
        data: { attendees: { create: Array<{ user: { connect: { id: string } } }> } };
      };

      expect(createCall.data.attendees.create).toHaveLength(1);
      expect(createCall.data.attendees.create[0].user.connect.id).toBe('user-1');
    });

    it('creates only the host attendee when inviteUserIds is not provided', async () => {
      const createdEvent = stubEventFixture();
      db.$transaction.mockImplementation((cb) => cb(db));
      db.event.create.mockResolvedValue(createdEvent);

      await service.createEvent('user-1', makeCreateDto());

      const createCall = db.event.create.mock.calls[0][0] as {
        data: { attendees: { create: Array<{ user: { connect: { id: string } } }> } };
      };

      expect(createCall.data.attendees.create).toHaveLength(1);
    });
  });

  describe('updateEvent', () => {
    it('updates an existing event', async () => {
      const updated = stubEventFixture({ title: 'Updated Title' });
      db.event.count.mockResolvedValue(1);
      db.event.update.mockResolvedValue(updated);

      const dto: UpdateEventDto = { title: 'Updated Title' };
      const result = await service.updateEvent('event-1', dto, [userAbility]);

      expect(db.event.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'event-1', deletedAt: null },
        }),
      );

      expect(db.event.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'event-1' }),
          data: expect.objectContaining({ title: 'Updated Title' }),
        }),
      );

      expect(result).toBe(updated);
    });

    it('throws BadRequestException when DTO is empty', async () => {
      await expect(service.updateEvent('event-1', {} as UpdateEventDto, [userAbility])).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws NotFoundException when event does not exist', async () => {
      db.event.count.mockResolvedValue(0);

      await expect(service.updateEvent('nonexistent', { title: 'X' }, [userAbility])).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ForbiddenException on PrismaError.DependentRecordNotFound', async () => {
      db.event.count.mockResolvedValue(1);

      const prismaError = new Prisma.PrismaClientKnownRequestError('', {
        code: PrismaError.DependentRecordNotFound,
        clientVersion: '0',
      });
      db.event.update.mockRejectedValue(prismaError);

      await expect(service.updateEvent('event-1', { title: 'X' }, [userAbility])).rejects.toThrow(ForbiddenException);
    });

    it('re-throws unexpected errors', async () => {
      db.event.count.mockResolvedValue(1);
      const error = new Error('DB connection lost');
      db.event.update.mockRejectedValue(error);

      await expect(service.updateEvent('event-1', { title: 'X' }, [userAbility])).rejects.toThrow('DB connection lost');
    });

    it('connects household when householdId is provided', async () => {
      db.event.count.mockResolvedValue(1);
      db.event.update.mockResolvedValue(stubEventFixture());

      await service.updateEvent('event-1', { householdId: 'hh-new' } as UpdateEventDto, [userAbility]);

      expect(db.event.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            household: { connect: { id: 'hh-new' } },
          }),
        }),
      );
    });

    it('disconnects household when householdId is explicitly null', async () => {
      db.event.count.mockResolvedValue(1);
      db.event.update.mockResolvedValue(stubEventFixture());

      await service.updateEvent('event-1', { householdId: null } as unknown as UpdateEventDto, [userAbility]);

      expect(db.event.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            household: { disconnect: true },
          }),
        }),
      );
    });
  });

  describe('deleteEvent', () => {
    it('soft-deletes an event by setting deletedAt', async () => {
      const deleted = stubEventFixture({ deletedAt: new Date() });
      db.event.count.mockResolvedValue(1);
      db.event.update.mockResolvedValue(deleted);

      const result = await service.deleteEvent('event-1', 'user-1', [userAbility]);

      expect(db.event.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'event-1' }),
          data: { deletedAt: expect.any(Date) },
        }),
      );

      expect(result).toBe(deleted);
    });

    it('throws NotFoundException when event does not exist', async () => {
      db.event.count.mockResolvedValue(0);

      await expect(service.deleteEvent('nonexistent', 'user-1', [userAbility])).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException on PrismaError.DependentRecordNotFound', async () => {
      db.event.count.mockResolvedValue(1);

      const prismaError = new Prisma.PrismaClientKnownRequestError('', {
        code: PrismaError.DependentRecordNotFound,
        clientVersion: '0',
      });
      db.event.update.mockRejectedValue(prismaError);

      await expect(service.deleteEvent('event-1', 'user-1', [userAbility])).rejects.toThrow(ForbiddenException);
    });

    it('emits an EventDeleted domain event', async () => {
      db.event.count.mockResolvedValue(1);
      db.event.update.mockResolvedValue(stubEventFixture());

      await service.deleteEvent('event-1', 'user-del', [userAbility]);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EventEvents.EventDeleted,
        expect.objectContaining({
          eventId: 'event-1',
          deletedById: 'user-del',
        } satisfies EventDeletedEvent),
      );
    });

    it('does not emit EventDeleted when the delete fails', async () => {
      db.event.count.mockResolvedValue(0);

      await expect(service.deleteEvent('nonexistent', 'user-1', [userAbility])).rejects.toThrow();

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });
});

function stubEventFixture(overrides: Partial<Event> = {}): Event {
  return makeEvent({
    householdId: 'household-1',
    createdById: 'user-1',
    ...overrides,
  });
}

function makeCreateDto(overrides: Partial<CreateEventDto> = {}): CreateEventDto {
  return {
    title: 'Board Game Night',
    ...overrides,
  } as CreateEventDto;
}
