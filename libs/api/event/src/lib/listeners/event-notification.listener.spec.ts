import { EventAvailabilityVote, NotificationType } from '@bge/database';
import { NotificationsService } from '@bge/notifications-service';
import {
  createTestingModuleWithDb,
  makeEvent,
  makeEventAttendee,
  makeEventOccurrence,
  makeGame,
  makeHouseholdMember,
  MockDatabaseService,
} from '@bge/testing';
import type { AttendeeAddedEvent } from '../attendee/interfaces';
import type { EventCreatedEvent } from '../interfaces/event.interface';
import type { NominationCreatedEvent, NominationResolvedEvent } from '../nomination/interfaces';
import type { OccurrenceStatusChangedEvent } from '../occurrence/interfaces';
import { EventNotificationListener } from './event-notification.listener';

describe('EventNotificationListener', () => {
  let listener: EventNotificationListener;
  let db: MockDatabaseService;
  let notifications: jest.Mocked<Pick<NotificationsService, 'create' | 'createMany'>>;

  beforeEach(async () => {
    notifications = {
      create: jest.fn().mockResolvedValue(undefined),
      createMany: jest.fn().mockResolvedValue(undefined),
    };

    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [EventNotificationListener, { provide: NotificationsService, useValue: notifications }],
    });

    listener = module.get(EventNotificationListener);
    db = mockDb;
  });

  afterEach(() => jest.clearAllMocks());

  describe('onEventCreated', () => {
    const event: EventCreatedEvent = {
      eventId: 'ev-1',
      createdById: 'user-creator',
      householdId: 'hh-1',
      title: 'Game Night',
      invitedUserIds: [],
    };

    it('sends invite notifications even for venue-based events (no householdId)', async () => {
      await listener.onEventCreated({
        ...event,
        householdId: null,
        invitedUserIds: ['user-friend-1'],
      });

      expect(db.householdMember.findMany).not.toHaveBeenCalled();
      expect(notifications.createMany).toHaveBeenCalledWith([
        expect.objectContaining({
          userId: 'user-friend-1',
          type: NotificationType.EventInviteReceived,
        }),
      ]);
    });

    it('notifies household members excluding the creator and invited users', async () => {
      db.householdMember.findMany.mockResolvedValue([
        makeHouseholdMember({ userId: 'user-a', householdId: 'hh-1' }),
        makeHouseholdMember({ userId: 'user-b', householdId: 'hh-1' }),
      ]);

      await listener.onEventCreated(event);

      expect(notifications.createMany).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            userId: 'user-a',
            type: NotificationType.EventCreated,
          }),
          expect.objectContaining({
            userId: 'user-b',
            type: NotificationType.EventCreated,
          }),
        ]),
      );
    });

    it('skips when householdId is null (venue-based event)', async () => {
      await listener.onEventCreated({ ...event, householdId: null });

      expect(db.householdMember.findMany).not.toHaveBeenCalled();
      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    it('skips when no other household members exist', async () => {
      db.householdMember.findMany.mockResolvedValue([]);

      await listener.onEventCreated(event);

      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    it('sends EventInviteReceived to explicitly invited users', async () => {
      db.householdMember.findMany.mockResolvedValue([]);

      await listener.onEventCreated({
        ...event,
        invitedUserIds: ['user-friend-1', 'user-friend-2'],
      });

      expect(notifications.createMany).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            userId: 'user-friend-1',
            type: NotificationType.EventInviteReceived,
            payload: expect.objectContaining({
              eventId: 'ev-1',
              eventTitle: 'Game Night',
            }),
          }),
          expect.objectContaining({
            userId: 'user-friend-2',
            type: NotificationType.EventInviteReceived,
          }),
        ]),
      );
    });

    it('excludes invited users from household EventCreated notifications to avoid double-notifying', async () => {
      db.householdMember.findMany.mockResolvedValue([
        makeHouseholdMember({ userId: 'user-a', householdId: 'hh-1' }), // not invited — should get EventCreated
      ]);

      await listener.onEventCreated({
        ...event,
        invitedUserIds: ['user-b'], // invited — should get EventInviteReceived only
      });

      const allNotifications = notifications.createMany.mock.calls[0][0] as Array<{
        userId: string;
        type: string;
      }>;

      // user-a gets EventCreated, user-b gets EventInviteReceived
      expect(allNotifications).toHaveLength(2);
      expect(allNotifications.find((n) => n.userId === 'user-a')?.type).toBe(NotificationType.EventCreated);
      expect(allNotifications.find((n) => n.userId === 'user-b')?.type).toBe(NotificationType.EventInviteReceived);
    });

    it('skips when no other household members exist and no invitees', async () => {
      db.householdMember.findMany.mockResolvedValue([]);

      await listener.onEventCreated(event);

      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    it('skips entirely when no household and no invitees', async () => {
      await listener.onEventCreated({
        ...event,
        householdId: null,
        invitedUserIds: [],
      });

      expect(notifications.createMany).not.toHaveBeenCalled();
    });
  });

  describe('onAttendeeAdded', () => {
    it('notifies the invited user', async () => {
      db.event.findUnique.mockResolvedValue(makeEvent({ title: 'Strategy Night' }));

      const event: AttendeeAddedEvent = {
        eventId: 'ev-1',
        attendeeId: 'att-1',
        userId: 'user-invited',
        guestName: null,
        role: 'EventParticipant',
        addedById: 'user-host',
      };

      await listener.onAttendeeAdded(event);

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-invited',
          type: NotificationType.EventInviteReceived,
          payload: expect.objectContaining({
            eventId: 'ev-1',
            eventTitle: 'Strategy Night',
          }),
        }),
      );
    });

    it('skips guest attendees (no userId)', async () => {
      const event: AttendeeAddedEvent = {
        eventId: 'ev-1',
        attendeeId: 'att-1',
        userId: null,
        guestName: 'Alice',
        role: 'EventGuest',
        addedById: 'user-host',
      };

      await listener.onAttendeeAdded(event);

      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  describe('onNominationCreated', () => {
    it('notifies all attendees except the nominator', async () => {
      db.event.findUnique.mockResolvedValue(makeEvent({ title: 'Game Night', createdById: 'user-host', id: 'ev-1' }));
      db.game.findUnique.mockResolvedValue(makeGame({ title: 'Wingspan' }));
      db.eventAttendee.findMany.mockResolvedValue([
        makeEventAttendee({ id: 'att-nominator', userId: 'user-a', eventId: 'ev-1' }),
        makeEventAttendee({ id: 'att-other', userId: 'user-b', eventId: 'ev-1' }),
        makeEventAttendee({ id: 'att-another', userId: 'user-c', eventId: 'ev-1' }),
      ]);

      const event: NominationCreatedEvent = {
        eventId: 'ev-1',
        nominationId: 'nom-1',
        platformGameId: 'plat-game-1',
        nominatedByAttendeeId: 'att-nominator',
      };

      await listener.onNominationCreated(event);

      expect(notifications.createMany).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            userId: 'user-b',
            type: NotificationType.GameNominated,
          }),
          expect.objectContaining({
            userId: 'user-c',
            type: NotificationType.GameNominated,
          }),
        ]),
      );

      // Should NOT include the nominator
      const calls = notifications.createMany.mock.calls[0][0];
      expect(calls.every((c: { userId: string }) => c.userId !== 'user-a')).toBe(true);
    });
  });

  describe('onNominationResolved', () => {
    const baseEvent: NominationResolvedEvent = {
      eventId: 'ev-1',
      nominationId: 'nom-1',
      platformGameId: 'plat-game-1',
      status: 'Approved',
      elevatedToEventGameId: 'eg-1',
    };

    beforeEach(() => {
      db.eventGameNomination.findUnique.mockResolvedValue({
        nominatedById: 'att-1',
        ...(<any>{
          nominatedBy: { userId: 'user-nominator' },
          platformGame: { game: { title: 'Wingspan' } },
        }),
        platformGameId: 'plat-game-1',
      });
    });

    it('notifies the nominator on Approved', async () => {
      await listener.onNominationResolved({ ...baseEvent });

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-nominator',
          type: NotificationType.GameNominationApproved,
        }),
      );
    });

    it('notifies the nominator on Rejected', async () => {
      await listener.onNominationResolved({
        ...baseEvent,
        status: 'Rejected',
        elevatedToEventGameId: null,
      });

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.GameNominationRejected,
        }),
      );
    });

    it('notifies the nominator on Passed', async () => {
      await listener.onNominationResolved({ ...baseEvent, status: 'Passed' });

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.GameNominationPassed,
        }),
      );
    });

    it('notifies the nominator on Failed', async () => {
      await listener.onNominationResolved({
        ...baseEvent,
        status: 'Failed',
        elevatedToEventGameId: null,
      });

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.GameNominationFailed,
        }),
      );
    });

    it('does not notify on Withdrawn status', async () => {
      await listener.onNominationResolved({
        ...baseEvent,
        status: 'Withdrawn',
        elevatedToEventGameId: null,
      });

      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  describe('onOccurrenceConfirmed', () => {
    const event: OccurrenceStatusChangedEvent = {
      eventId: 'ev-1',
      occurrenceId: 'occ-1',
      previousStatus: 'Proposed',
      newStatus: 'Confirmed',
    };

    it('notifies voters who are not the host', async () => {
      db.event.findUnique.mockResolvedValue(
        makeEvent({
          title: 'Game Night',
          createdById: 'user-host',
          id: 'ev-1',
        }),
      );

      db.eventOccurrence.findUnique.mockResolvedValue(
        makeEventOccurrence({
          eventId: 'ev-1',
          label: 'Saturday',
          startDate: new Date(),
        }),
      );

      db.eventAvailabilityVote.findMany.mockResolvedValue([
        makeAvailabilityVote({
          attendeeId: 'attendee-a',
          ...(<any>{ attendee: { userId: 'user-a' } }),
        }),
        makeAvailabilityVote({
          attendeeId: 'attendee-host',
          ...(<any>{ attendee: { userId: 'user-host' } }),
        }), // should be excluded
      ]);

      await listener.onOccurrenceConfirmed(event);

      expect(notifications.createMany).toHaveBeenCalledWith([
        expect.objectContaining({
          userId: 'user-a',
          type: NotificationType.EventOccurrenceConfirmed,
          payload: expect.objectContaining({
            occurrenceId: 'occ-1',
            occurrenceLabel: 'Saturday',
          }),
        }),
      ]);
    });
  });

  describe('error handling', () => {
    it('does not throw when notification creation fails', async () => {
      db.householdMember.findMany.mockResolvedValue([makeHouseholdMember({ userId: 'u1', householdId: 'hh-1' })]);
      notifications.createMany.mockRejectedValue(new Error('DB down'));

      // Should not throw — listener swallows errors and logs them
      await expect(
        listener.onEventCreated({
          eventId: 'ev-1',
          createdById: 'user-1',
          householdId: 'hh-1',
          title: 'Game Night',
          invitedUserIds: [],
        }),
      ).resolves.toBeUndefined();
    });
  });
});

function makeAvailabilityVote(overrides: Partial<EventAvailabilityVote> = {}): EventAvailabilityVote {
  return {
    id: `av-${Math.random()}`,
    occurrenceId: 'occ-1',
    attendeeId: 'attendee-1',
    response: 'Available',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}
