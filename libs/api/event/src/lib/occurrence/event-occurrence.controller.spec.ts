import { AvailabilityResponse, EventAvailabilityVote, EventOccurrence, OccurrenceStatus } from '@bge/database';
import { PoliciesGuard } from '@bge/permissions';
import { createTestingModuleWithDb, makeEventAttendee, makeEventOccurrence } from '@bge/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { firstValueFrom } from 'rxjs';
import { EventAttendeeService } from '../attendee/event-attendee.service';
import { EventOccurrenceController } from './event-occurrence.controller';
import { EventOccurrenceService } from './event-occurrence.service';
import { AvailabilitySummary } from './interfaces';

describe('EventOccurrenceController', () => {
  let controller: EventOccurrenceController;
  let attendeeService: jest.Mocked<Pick<EventAttendeeService, 'getAttendeeByUserId'>>;
  let service: jest.Mocked<
    Pick<
      EventOccurrenceService,
      | 'getOccurrences'
      | 'getOccurrence'
      | 'addOccurrence'
      | 'updateOccurrence'
      | 'removeOccurrence'
      | 'confirmOccurrence'
      | 'declineOccurrence'
      | 'cancelOccurrence'
      | 'submitAvailability'
      | 'getAvailabilitySummary'
    >
  >;

  beforeEach(async () => {
    service = {
      getOccurrences: jest.fn(),
      getOccurrence: jest.fn(),
      addOccurrence: jest.fn(),
      updateOccurrence: jest.fn(),
      removeOccurrence: jest.fn(),
      confirmOccurrence: jest.fn(),
      declineOccurrence: jest.fn(),
      cancelOccurrence: jest.fn(),
      submitAvailability: jest.fn(),
      getAvailabilitySummary: jest.fn(),
    } satisfies Partial<jest.Mocked<EventOccurrenceService>> as typeof service;

    attendeeService = {
      getAttendeeByUserId: jest.fn(),
    } satisfies Partial<jest.Mocked<EventAttendeeService>> as typeof attendeeService;

    const { module } = await createTestingModuleWithDb({
      controllers: [EventOccurrenceController],
      providers: [
        { provide: EventOccurrenceService, useValue: service },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: EventAttendeeService, useValue: attendeeService },
      ],
      overrideGuards: [AuthGuard, PoliciesGuard],
    });

    controller = module.get(EventOccurrenceController);
  });

  afterEach(() => jest.clearAllMocks());

  describe('getOccurrences', () => {
    it('delegates and wraps in { occurrences }', async () => {
      const occurrences = [stubOcc(), stubOcc()];
      service.getOccurrences.mockResolvedValue(occurrences);

      const result = await firstValueFrom(controller.getOccurrences('event-1'));

      expect(service.getOccurrences).toHaveBeenCalledWith('event-1');
      expect(result).toEqual({ occurrences });
    });
  });

  describe('getOccurrence', () => {
    it('delegates and wraps in { occurrence }', async () => {
      const occ = stubOcc({ id: 'occ-42' });
      service.getOccurrence.mockResolvedValue(occ);

      const result = await firstValueFrom(controller.getOccurrence('event-1', 'occ-42'));

      expect(service.getOccurrence).toHaveBeenCalledWith('event-1', 'occ-42');
      expect(result).toEqual({ occurrence: occ });
    });
  });

  describe('addOccurrence', () => {
    it('delegates and returns { message, occurrence }', async () => {
      const created = stubOcc({ id: 'occ-new' });
      service.addOccurrence.mockResolvedValue(created);

      const dto = { startDate: new Date() };
      const result = await firstValueFrom(controller.addOccurrence('event-1', dto));

      expect(service.addOccurrence).toHaveBeenCalledWith('event-1', dto);
      expect(result).toEqual({
        message: 'Occurrence added',
        occurrence: created,
      });
    });
  });

  describe('updateOccurrence', () => {
    it('delegates and returns updated occurrence', async () => {
      const updated = stubOcc({ label: 'Updated' });
      service.updateOccurrence.mockResolvedValue(updated);

      const result = await firstValueFrom(controller.updateOccurrence('event-1', 'occ-1', { label: 'Updated' }));

      expect(service.updateOccurrence).toHaveBeenCalledWith('event-1', 'occ-1', { label: 'Updated' });
      expect(result).toEqual({
        message: 'Occurrence updated',
        occurrence: updated,
      });
    });
  });

  describe('removeOccurrence', () => {
    it('delegates and returns removed occurrence', async () => {
      const removed = stubOcc({ id: 'occ-del' });
      service.removeOccurrence.mockResolvedValue(removed);

      const result = await firstValueFrom(controller.removeOccurrence('event-1', 'occ-del'));

      expect(service.removeOccurrence).toHaveBeenCalledWith('event-1', 'occ-del');
      expect(result).toEqual({
        message: 'Occurrence removed',
        occurrence: removed,
      });
    });
  });

  describe('confirm', () => {
    it('delegates to confirmOccurrence', async () => {
      const confirmed = stubOcc({ status: OccurrenceStatus.Confirmed });
      service.confirmOccurrence.mockResolvedValue(confirmed);

      const result = await firstValueFrom(controller.confirm('event-1', 'occ-1'));

      expect(service.confirmOccurrence).toHaveBeenCalledWith('event-1', 'occ-1');
      expect(result).toEqual({
        message: 'Occurrence confirmed',
        occurrence: confirmed,
      });
    });
  });

  describe('decline', () => {
    it('delegates to declineOccurrence', async () => {
      const declined = stubOcc({ status: OccurrenceStatus.Declined });
      service.declineOccurrence.mockResolvedValue(declined);

      const result = await firstValueFrom(controller.decline('event-1', 'occ-1'));

      expect(service.declineOccurrence).toHaveBeenCalledWith('event-1', 'occ-1');
      expect(result).toEqual({
        message: 'Occurrence declined',
        occurrence: declined,
      });
    });
  });

  describe('cancel', () => {
    it('delegates to cancelOccurrence', async () => {
      const cancelled = stubOcc({ status: OccurrenceStatus.Cancelled });
      service.cancelOccurrence.mockResolvedValue(cancelled);

      const result = await firstValueFrom(controller.cancel('event-1', 'occ-1'));

      expect(service.cancelOccurrence).toHaveBeenCalledWith('event-1', 'occ-1');
      expect(result).toEqual({
        message: 'Occurrence cancelled',
        occurrence: cancelled,
      });
    });
  });

  describe('submitAvailability', () => {
    it('delegates with session userId', async () => {
      const vote = {
        id: 'av-1',
        response: AvailabilityResponse.Available,
      } as EventAvailabilityVote;
      service.submitAvailability.mockResolvedValue(vote);
      attendeeService.getAttendeeByUserId.mockResolvedValue(
        makeEventAttendee({
          id: 'att-42',
          eventId: 'event-1',
        }),
      );

      const result = await firstValueFrom(
        controller.submitAvailability('event-1', 'occ-1', makeSession('user-42'), {
          response: AvailabilityResponse.Available,
        }),
      );

      expect(service.submitAvailability).toHaveBeenCalledWith('event-1', 'occ-1', 'att-42', {
        response: AvailabilityResponse.Available,
      });
      expect(result).toEqual({
        message: 'Availability recorded',
        vote,
      });
    });
  });

  describe('getAvailabilitySummary', () => {
    it('delegates and wraps in { summary }', async () => {
      const summary: AvailabilitySummary = {
        attendees: {
          total: 4,
          registered: 3,
          guests: 1,
          byStatus: { attending: 2, invited: 1, maybe: 1, notAttending: 0 },
        },
        eligibleVoters: 3,
        occurrences: [
          {
            occurrenceId: 'occ-1',
            label: 'Saturday',
            startDate: null,
            endDate: null,
            status: OccurrenceStatus.Proposed,
            available: 3,
            maybe: 1,
            unavailable: 0,
            totalVotes: 4,
            pendingVotes: 0,
            participationRate: 1,
            voters: [],
          },
        ],
      };
      service.getAvailabilitySummary.mockResolvedValue(summary);

      const result = await firstValueFrom(controller.getAvailabilitySummary('event-1'));

      expect(service.getAvailabilitySummary).toHaveBeenCalledWith('event-1');
      expect(result).toEqual({ summary });
    });
  });
});

function stubOcc(overrides: Partial<EventOccurrence> = {}): EventOccurrence {
  return makeEventOccurrence({
    eventId: 'event-1',
    ...overrides,
  });
}

function makeSession(userId = 'user-1') {
  return { user: { id: userId } } as UserSession;
}
