import {
  AvailabilityResponse,
  EventAvailabilityVote,
  EventOccurrence,
  EventParticipationStatus,
  EventSchedulingMode,
  OccurrenceStatus,
} from '@bge/database';
import {
  createTestingModuleWithDb,
  makeEvent,
  makeEventAttendee,
  makeEventOccurrence,
  MockDatabaseService,
} from '@bge/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DateTime } from 'luxon';
import { OccurrenceEvents } from './constants';
import { AddOccurrenceDto } from './dto/add-occurrence.dto';
import { EventOccurrenceService } from './event-occurrence.service';
import type { AvailabilityVoteSubmittedEvent, OccurrenceAddedEvent, OccurrenceStatusChangedEvent } from './interfaces';

describe('EventOccurrenceService', () => {
  let service: EventOccurrenceService;
  let db: MockDatabaseService;
  let eventEmitter: jest.Mocked<Pick<EventEmitter2, 'emit'>>;

  beforeEach(async () => {
    eventEmitter = { emit: jest.fn() };

    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [EventOccurrenceService, { provide: EventEmitter2, useValue: eventEmitter }],
    });

    service = module.get(EventOccurrenceService);
    db = mockDb;
  });

  afterEach(() => jest.clearAllMocks());

  describe('getOccurrences', () => {
    it('returns occurrences ordered by sortOrder', async () => {
      stubEventExists(db);

      const occurrences = [stubOccurrence({ sortOrder: 0 }), stubOccurrence({ sortOrder: 1 })];
      db.eventOccurrence.findMany.mockResolvedValue(occurrences);

      const result = await service.getOccurrences('event-1');

      expect(db.eventOccurrence.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { eventId: 'event-1' },
          orderBy: { sortOrder: 'asc' },
        }),
      );
      expect(result).toHaveLength(2);
    });

    it('throws NotFoundException when event does not exist', async () => {
      stubEventExists(db, false);

      await expect(service.getOccurrences('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getOccurrence', () => {
    it('returns a single occurrence with includes', async () => {
      stubEventExists(db);

      const occ = stubOccurrence({ id: 'occ-1' });
      db.eventOccurrence.findUnique.mockResolvedValue(occ);

      const result = await service.getOccurrence('event-1', 'occ-1');
      expect(result).toBe(occ);
    });

    it('throws NotFoundException when occurrence does not exist', async () => {
      stubEventExists(db);

      db.eventOccurrence.findUnique.mockResolvedValue(null);

      await expect(service.getOccurrence('event-1', 'nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('addOccurrence', () => {
    it('creates occurrence with Proposed status for Poll mode', async () => {
      db.event.findUnique.mockResolvedValue(
        makeEvent({
          householdId: 'house-1',
          createdById: 'user-1',
          id: 'event-1',
          schedulingMode: EventSchedulingMode.Poll,
        }),
      );

      const created = stubOccurrence({
        id: 'occ-new',
        status: OccurrenceStatus.Proposed,
      });

      db.eventOccurrence.create.mockResolvedValue(created);

      const dto: AddOccurrenceDto = {
        startDate: DateTime.now().plus({ days: 1 }).toJSDate(),
        label: 'Option A',
      };
      const result = await service.addOccurrence('event-1', dto);

      expect(db.eventOccurrence.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: OccurrenceStatus.Proposed,
            label: 'Option A',
          }),
        }),
      );
      expect(result).toBe(created);
    });

    it('creates occurrence with Confirmed status for MultiDay mode', async () => {
      db.event.findUnique.mockResolvedValue(
        makeEvent({
          householdId: 'house-1',
          createdById: 'user-1',
          id: 'event-1',
          schedulingMode: EventSchedulingMode.MultiDay,
        }),
      );
      db.eventOccurrence.create.mockResolvedValue(stubOccurrence());

      await service.addOccurrence('event-1', {
        startDate: new Date(),
      });

      expect(db.eventOccurrence.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: OccurrenceStatus.Confirmed,
          }),
        }),
      );
    });

    it('prevents adding a second occurrence in Fixed mode', async () => {
      db.event.findUnique.mockResolvedValue(
        makeEvent({
          householdId: 'house-1',
          createdById: 'user-1',
          id: 'event-1',
          schedulingMode: EventSchedulingMode.Fixed,
        }),
      );
      db.eventOccurrence.count.mockResolvedValue(1);

      await expect(service.addOccurrence('event-1', { startDate: new Date() })).rejects.toThrow(BadRequestException);
    });

    it('allows the first occurrence in Fixed mode', async () => {
      db.event.findUnique.mockResolvedValue(
        makeEvent({
          createdById: 'user-1',
          householdId: 'house-1',
          id: 'event-1',
          schedulingMode: EventSchedulingMode.Fixed,
        }),
      );

      db.eventOccurrence.count.mockResolvedValue(0);
      db.eventOccurrence.create.mockResolvedValue(stubOccurrence());

      await expect(service.addOccurrence('event-1', { startDate: new Date() })).resolves.toBeDefined();
    });

    it('emits OccurrenceAdded domain event', async () => {
      db.event.findUnique.mockResolvedValue(
        makeEvent({
          householdId: 'house-1',
          createdById: 'user-1',
          id: 'event-1',
          schedulingMode: EventSchedulingMode.Poll,
        }),
      );
      db.eventOccurrence.create.mockResolvedValue(stubOccurrence({ id: 'occ-emit' }));

      await service.addOccurrence('event-1', {});

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        OccurrenceEvents.OccurrenceAdded,
        expect.objectContaining({
          eventId: 'event-1',
          occurrenceId: 'occ-emit',
          status: OccurrenceStatus.Proposed,
        } satisfies OccurrenceAddedEvent),
      );
    });

    it('throws NotFoundException when event does not exist', async () => {
      db.event.findUnique.mockResolvedValue(null);

      await expect(service.addOccurrence('nonexistent', {})).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateOccurrence', () => {
    it('updates occurrence fields', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue(stubOccurrence({ id: 'occ-1' }));

      const updated = stubOccurrence({ label: 'Updated Label' });
      db.eventOccurrence.update.mockResolvedValue(updated);

      const result = await service.updateOccurrence('event-1', 'occ-1', {
        label: 'Updated Label',
      });

      expect(db.eventOccurrence.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ label: 'Updated Label' }),
        }),
      );
      expect(result).toBe(updated);
    });

    it('throws BadRequestException when DTO is empty', async () => {
      await expect(service.updateOccurrence('event-1', 'occ-1', {})).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when occurrence does not exist', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue(null);

      await expect(service.updateOccurrence('event-1', 'nonexistent', { label: 'X' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('removeOccurrence', () => {
    it('deletes the occurrence', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue(stubOccurrence({ id: 'occ-1' }));

      const deleted = stubOccurrence({ id: 'occ-1' });
      db.eventOccurrence.delete.mockResolvedValue(deleted);

      const result = await service.removeOccurrence('event-1', 'occ-1');

      expect(db.eventOccurrence.delete).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'occ-1' } }));
      expect(result).toBe(deleted);
    });

    it('throws NotFoundException when not found', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue(null);

      await expect(service.removeOccurrence('event-1', 'nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('confirmOccurrence', () => {
    it('transitions Proposed → Confirmed and sets confirmedAt', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue(
        stubOccurrence({ id: 'occ-1', status: OccurrenceStatus.Proposed }),
      );

      const confirmed = stubOccurrence({ status: OccurrenceStatus.Confirmed });
      db.eventOccurrence.update.mockResolvedValue(confirmed);

      const result = await service.confirmOccurrence('event-1', 'occ-1');

      expect(db.eventOccurrence.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: OccurrenceStatus.Confirmed,
            confirmedAt: expect.any(Date),
          }),
        }),
      );
      expect(result).toBe(confirmed);
    });

    it('emits OccurrenceConfirmed domain event', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue(
        stubOccurrence({ id: 'occ-1', status: OccurrenceStatus.Proposed }),
      );
      db.eventOccurrence.update.mockResolvedValue(stubOccurrence());

      await service.confirmOccurrence('event-1', 'occ-1');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        OccurrenceEvents.OccurrenceConfirmed,
        expect.objectContaining({
          eventId: 'event-1',
          occurrenceId: 'occ-1',
          previousStatus: OccurrenceStatus.Proposed,
          newStatus: OccurrenceStatus.Confirmed,
        } satisfies OccurrenceStatusChangedEvent),
      );
    });

    it('rejects transition from Confirmed', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue(
        stubOccurrence({ id: 'occ-1', status: OccurrenceStatus.Confirmed }),
      );

      await expect(service.confirmOccurrence('event-1', 'occ-1')).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when not found', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue(null);

      await expect(service.confirmOccurrence('event-1', 'nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('declineOccurrence', () => {
    it('transitions Proposed → Declined and sets declinedAt', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue(
        stubOccurrence({ id: 'occ-1', status: OccurrenceStatus.Proposed }),
      );
      db.eventOccurrence.update.mockResolvedValue(stubOccurrence({ status: OccurrenceStatus.Declined }));

      await service.declineOccurrence('event-1', 'occ-1');

      expect(db.eventOccurrence.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: OccurrenceStatus.Declined,
            declinedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('rejects transition from Confirmed', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue(
        stubOccurrence({
          id: 'occ-1',
          status: OccurrenceStatus.Confirmed,
        }),
      );

      await expect(service.declineOccurrence('event-1', 'occ-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('cancelOccurrence', () => {
    it('transitions Confirmed → Cancelled', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue(
        stubOccurrence({
          id: 'occ-1',
          status: OccurrenceStatus.Confirmed,
        }),
      );
      db.eventOccurrence.update.mockResolvedValue(stubOccurrence({ status: OccurrenceStatus.Cancelled }));

      await service.cancelOccurrence('event-1', 'occ-1');

      expect(db.eventOccurrence.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: OccurrenceStatus.Cancelled,
          }),
        }),
      );
    });

    it('rejects transition from Proposed', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue(
        stubOccurrence({
          id: 'occ-1',
          status: OccurrenceStatus.Proposed,
        }),
      );

      await expect(service.cancelOccurrence('event-1', 'occ-1')).rejects.toThrow(BadRequestException);
    });

    it('emits OccurrenceCancelled domain event', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue(
        stubOccurrence({
          id: 'occ-1',
          status: OccurrenceStatus.Confirmed,
        }),
      );
      db.eventOccurrence.update.mockResolvedValue(stubOccurrence());

      await service.cancelOccurrence('event-1', 'occ-1');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        OccurrenceEvents.OccurrenceCancelled,
        expect.objectContaining({
          previousStatus: OccurrenceStatus.Confirmed,
          newStatus: OccurrenceStatus.Cancelled,
        }),
      );
    });
  });

  describe('submitAvailability', () => {
    it('upserts an availability vote on a Proposed occurrence', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue(
        stubOccurrence({
          id: 'occ-1',
          status: OccurrenceStatus.Proposed,
        }),
      );

      const vote = makeAvailabilityVote({ id: 'av-1' });
      db.eventAvailabilityVote.upsert.mockResolvedValue(vote);

      const result = await service.submitAvailability('event-1', 'occ-1', 'attendee-1', {
        response: AvailabilityResponse.Available,
      });

      expect(db.eventAvailabilityVote.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            occurrenceId_attendeeId: { occurrenceId: 'occ-1', attendeeId: 'attendee-1' },
          },
          create: expect.objectContaining({
            response: AvailabilityResponse.Available,
          }),
          update: expect.objectContaining({
            response: AvailabilityResponse.Available,
          }),
        }),
      );
      expect(result).toBe(vote);
    });

    it('emits AvailabilityVoteSubmitted domain event', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue(
        stubOccurrence({
          id: 'occ-1',
          status: OccurrenceStatus.Proposed,
        }),
      );
      db.eventAvailabilityVote.upsert.mockResolvedValue(makeAvailabilityVote({ id: 'av-1' }));

      await service.submitAvailability('event-1', 'occ-1', 'attendee-1', {
        response: AvailabilityResponse.Maybe,
      });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        OccurrenceEvents.AvailabilityVoteSubmitted,
        expect.objectContaining({
          eventId: 'event-1',
          occurrenceId: 'occ-1',
          attendeeId: 'attendee-1',
          response: AvailabilityResponse.Maybe,
        } satisfies AvailabilityVoteSubmittedEvent),
      );
    });

    it('rejects voting on a Confirmed occurrence', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue(
        stubOccurrence({
          id: 'occ-1',
          status: OccurrenceStatus.Confirmed,
        }),
      );

      await expect(
        service.submitAvailability('event-1', 'occ-1', 'user-1', {
          response: AvailabilityResponse.Available,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects voting on a Declined occurrence', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue(
        stubOccurrence({
          id: 'occ-1',
          status: OccurrenceStatus.Declined,
        }),
      );

      await expect(
        service.submitAvailability('event-1', 'occ-1', 'user-1', {
          response: AvailabilityResponse.Available,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when occurrence does not exist', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue(null);

      await expect(
        service.submitAvailability('event-1', 'nonexistent', 'user-1', {
          response: AvailabilityResponse.Available,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getAvailabilitySummary', () => {
    it('aggregates votes per occurrence and includes attendee context', async () => {
      stubEventExists(db);
      stubAttendees(db, [
        { userId: 'u1', status: EventParticipationStatus.Attending },
        { userId: 'u2', status: EventParticipationStatus.Attending },
        { userId: 'u3', status: EventParticipationStatus.Invited },
        { userId: null, status: EventParticipationStatus.Invited }, // guest — cannot vote
      ]);

      db.eventOccurrence.findMany.mockResolvedValue([
        {
          id: 'occ-1',
          label: 'Saturday',
          startDate: new Date('2024-07-06T18:00:00Z'),
          endDate: null,
          status: OccurrenceStatus.Proposed,
          ...(<any>{
            availabilityVotes: [
              { userId: 'u1', response: AvailabilityResponse.Available },
              { userId: 'u2', response: AvailabilityResponse.Available },
              { userId: 'u3', response: AvailabilityResponse.Maybe },
            ],
          }),
        },
        {
          id: 'occ-2',
          label: 'Sunday',
          startDate: new Date('2024-07-07T18:00:00Z'),
          endDate: null,
          status: OccurrenceStatus.Proposed,
          ...(<any>{
            availabilityVotes: [
              { userId: 'u1', response: AvailabilityResponse.Unavailable },
              { userId: 'u2', response: AvailabilityResponse.Available },
            ],
          }),
        },
      ]);

      const summary = await service.getAvailabilitySummary('event-1');

      // Event-level attendee context
      expect(summary.attendees).toEqual({
        total: 4,
        registered: 3,
        guests: 1,
        byStatus: {
          attending: 2,
          invited: 2,
          maybe: 0,
          notAttending: 0,
        },
      });
      expect(summary.eligibleVoters).toBe(3);

      // Per-occurrence
      expect(summary.occurrences).toHaveLength(2);

      expect(summary.occurrences[0]).toEqual(
        expect.objectContaining({
          occurrenceId: 'occ-1',
          label: 'Saturday',
          available: 2,
          maybe: 1,
          unavailable: 0,
          totalVotes: 3,
          pendingVotes: 0,
          participationRate: 1,
        }),
      );

      expect(summary.occurrences[1]).toEqual(
        expect.objectContaining({
          occurrenceId: 'occ-2',
          available: 1,
          maybe: 0,
          unavailable: 1,
          totalVotes: 2,
          pendingVotes: 1,
          participationRate: 0.67,
        }),
      );
    });

    it('includes voter details in each occurrence entry', async () => {
      stubEventExists(db);
      stubAttendees(db, [{ userId: 'u1', status: EventParticipationStatus.Attending }]);
      db.eventOccurrence.findMany.mockResolvedValue([
        {
          id: 'occ-1',
          label: null,
          startDate: null,
          endDate: null,
          status: OccurrenceStatus.Proposed,
          ...(<any>{ availabilityVotes: [{ attendeeId: 'u1', response: AvailabilityResponse.Available }] }),
        },
      ]);

      const summary = await service.getAvailabilitySummary('event-1');

      expect(summary.occurrences[0].voters).toEqual([{ attendeeId: 'u1', response: AvailabilityResponse.Available }]);
    });

    it('returns empty occurrences with zeroed attendee context for event with no attendees and no occurrences', async () => {
      stubEventExists(db);
      stubAttendees(db, []);

      db.eventOccurrence.findMany.mockResolvedValue([]);

      const summary = await service.getAvailabilitySummary('event-1');

      expect(summary.attendees.total).toBe(0);
      expect(summary.eligibleVoters).toBe(0);
      expect(summary.occurrences).toEqual([]);
    });

    it('handles occurrences with zero votes and computes pending correctly', async () => {
      stubEventExists(db);
      stubAttendees(db, [
        { userId: 'u1', status: EventParticipationStatus.Attending },
        { userId: 'u2', status: EventParticipationStatus.Maybe },
      ]);

      db.eventOccurrence.findMany.mockResolvedValue([
        {
          id: 'occ-1',
          label: null,
          startDate: null,
          endDate: null,
          status: OccurrenceStatus.Proposed,
          ...(<any>{ availabilityVotes: [] }),
        },
      ]);

      const summary = await service.getAvailabilitySummary('event-1');

      expect(summary.occurrences[0]).toEqual(
        expect.objectContaining({
          available: 0,
          maybe: 0,
          unavailable: 0,
          totalVotes: 0,
          pendingVotes: 2,
          participationRate: 0,
          voters: [],
        }),
      );
    });

    it('sets participationRate to 0 when there are no eligible voters', async () => {
      stubEventExists(db);
      stubAttendees(db, [
        { userId: null, status: EventParticipationStatus.Invited }, // guest only
      ]);
      db.eventOccurrence.findMany.mockResolvedValue([
        {
          id: 'occ-1',
          label: null,
          startDate: null,
          endDate: null,
          status: OccurrenceStatus.Proposed,
          ...(<any>{ availabilityVotes: [] }),
        },
      ]);

      const summary = await service.getAvailabilitySummary('event-1');

      expect(summary.eligibleVoters).toBe(0);
      expect(summary.occurrences[0].participationRate).toBe(0);
      expect(summary.occurrences[0].pendingVotes).toBe(0);
    });

    it('counts RSVP status breakdown correctly', async () => {
      stubEventExists(db);
      stubAttendees(db, [
        { userId: 'u1', status: EventParticipationStatus.Attending },
        { userId: 'u2', status: EventParticipationStatus.Attending },
        { userId: 'u3', status: EventParticipationStatus.Maybe },
        { userId: 'u4', status: EventParticipationStatus.NotAttending },
        { userId: 'u5', status: EventParticipationStatus.Invited },
        { userId: null, status: EventParticipationStatus.Invited },
      ]);

      db.eventOccurrence.findMany.mockResolvedValue([]);

      const summary = await service.getAvailabilitySummary('event-1');

      expect(summary.attendees.byStatus).toEqual({
        attending: 2,
        invited: 2,
        maybe: 1,
        notAttending: 1,
      });
      expect(summary.attendees.total).toBe(6);
      expect(summary.attendees.registered).toBe(5);
      expect(summary.attendees.guests).toBe(1);
    });
  });
});

function stubOccurrence(overrides: Partial<EventOccurrence> = {}): EventOccurrence {
  return makeEventOccurrence({
    eventId: 'event-1',
    ...overrides,
  });
}

function stubEventExists(db: MockDatabaseService, exists = true): void {
  db.event.count.mockResolvedValue(exists ? 1 : 0);
}

function makeAvailabilityVote(overrides: Partial<EventAvailabilityVote> = {}): EventAvailabilityVote {
  return {
    id: 'av-1',
    occurrenceId: 'occ-1',
    attendeeId: 'attendee-1',
    response: AvailabilityResponse.Available,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function stubAttendees(
  db: MockDatabaseService,
  attendees: { userId: string | null; status: EventParticipationStatus }[] = [],
) {
  db.eventAttendee.findMany.mockResolvedValue(attendees.map((a) => makeEventAttendee({ eventId: 'event-1', ...a })));
}
