import { EventAvailabilityVote, Game, NominationStatus, NotificationType, OccurrenceStatus, PlatformGame } from '@bge/database';
import { NotificationsService } from '@bge/notifications-service';
import {
  createTestingModuleWithDb,
  makeEvent,
  makeEventAttendee,
  makeEventOccurrence,
  makeHouseholdMember,
  makePlatformGame,
  MockDatabaseService,
} from '@bge/testing';
import { AttendeeAddedEvent } from '../attendee/events/attendee.events';
import { EventCreatedEvent } from '../events/event.events';
import { NominationCreatedEvent, NominationResolvedEvent } from '../nomination/events/nomination.events';
import { OccurrenceStatusChangedEvent } from '../occurrence/events/occurrence.events';
import { EventNotificationListener } from './event-notification.listener';

const makeCreatedEvent = (overrides: Partial<Parameters<typeof makeEvent>[0]> = {}, invitedUserIds: string[] = []) =>
  new EventCreatedEvent(
    makeEvent({ id: 'ev-1', title: 'Game Night', createdById: 'user-creator', householdId: 'hh-1', ...overrides }),
    invitedUserIds,
    new Date(),
  );

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
    it('sends invite notifications even for venue-based events (no householdId)', async () => {
      await listener.onEventCreated(makeCreatedEvent({ householdId: null }, ['user-friend-1']));

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

      await listener.onEventCreated(makeCreatedEvent());

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
      await listener.onEventCreated(makeCreatedEvent({ householdId: null }));

      expect(db.householdMember.findMany).not.toHaveBeenCalled();
      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    it('skips when no other household members exist', async () => {
      db.householdMember.findMany.mockResolvedValue([]);

      await listener.onEventCreated(makeCreatedEvent());

      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    it('sends EventInviteReceived to explicitly invited users', async () => {
      db.householdMember.findMany.mockResolvedValue([]);

      await listener.onEventCreated(makeCreatedEvent({}, ['user-friend-1', 'user-friend-2']));

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

      // user-b is invited — should get EventInviteReceived only
      await listener.onEventCreated(makeCreatedEvent({}, ['user-b']));

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

      await listener.onEventCreated(makeCreatedEvent());

      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    it('skips entirely when no household and no invitees', async () => {
      await listener.onEventCreated(makeCreatedEvent({ householdId: null }));

      expect(notifications.createMany).not.toHaveBeenCalled();
    });
  });

  describe('onAttendeeAdded', () => {
    it('notifies the invited user', async () => {
      db.event.findUnique.mockResolvedValue(makeEvent({ title: 'Strategy Night' }));

      const event = new AttendeeAddedEvent(
        makeEventAttendee({ id: 'att-1', eventId: 'ev-1', userId: 'user-invited' }),
        new Date(),
      );

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
      const event = new AttendeeAddedEvent(
        makeEventAttendee({ id: 'att-1', eventId: 'ev-1', userId: null, guestName: 'Alice' }),
        new Date(),
      );

      await listener.onAttendeeAdded(event);

      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  describe('onNominationCreated', () => {
    it('notifies all attendees except the nominator', async () => {
      db.event.findUnique.mockResolvedValue(makeEvent({ title: 'Game Night', createdById: 'user-host', id: 'ev-1' }));
      db.platformGame.findUnique.mockResolvedValue(
        stubPlatformGameWithGame({
          id: 'plat-game-1',
        }),
      );
      db.eventAttendee.findMany.mockResolvedValue([
        makeEventAttendee({ id: 'att-nominator', userId: 'user-a', eventId: 'ev-1' }),
        makeEventAttendee({ id: 'att-other', userId: 'user-b', eventId: 'ev-1' }),
        makeEventAttendee({ id: 'att-another', userId: 'user-c', eventId: 'ev-1' }),
      ]);

      const event = new NominationCreatedEvent(
        {
          id: 'nom-1',
          eventId: 'ev-1',
          occurrenceId: null,
          platformGameId: 'plat-game-1',
          nominatedById: 'att-nominator',
          suppliedFromId: 'gl-1',
          status: NominationStatus.Open,
          votingDeadline: null,
        },
        new Date(),
      );

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
    const makeResolvedEvent = (status: NominationStatus, elevatedToEventGameId: string | null = 'eg-1') =>
      new NominationResolvedEvent(
        { id: 'nom-1', eventId: 'ev-1', platformGameId: 'plat-game-1', status: NominationStatus.Open },
        { id: 'nom-1', eventId: 'ev-1', platformGameId: 'plat-game-1', status },
        elevatedToEventGameId,
        new Date(),
      );

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
      await listener.onNominationResolved(makeResolvedEvent(NominationStatus.Approved));

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-nominator',
          type: NotificationType.GameNominationApproved,
        }),
      );
    });

    it('notifies the nominator on Rejected', async () => {
      await listener.onNominationResolved(makeResolvedEvent(NominationStatus.Rejected, null));

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.GameNominationRejected,
        }),
      );
    });

    it('notifies the nominator on Passed', async () => {
      await listener.onNominationResolved(makeResolvedEvent(NominationStatus.Passed));

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.GameNominationPassed,
        }),
      );
    });

    it('notifies the nominator on Failed', async () => {
      await listener.onNominationResolved(makeResolvedEvent(NominationStatus.Failed, null));

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.GameNominationFailed,
        }),
      );
    });

    it('does not notify on Withdrawn status', async () => {
      await listener.onNominationResolved(makeResolvedEvent(NominationStatus.Withdrawn, null));

      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  describe('onOccurrenceConfirmed', () => {
    const event = new OccurrenceStatusChangedEvent(
      { id: 'occ-1', eventId: 'ev-1', status: OccurrenceStatus.Proposed },
      { id: 'occ-1', eventId: 'ev-1', status: OccurrenceStatus.Confirmed },
      new Date(),
    );

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
      await expect(listener.onEventCreated(makeCreatedEvent({ createdById: 'user-1' }))).resolves.toBeUndefined();
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

function stubPlatformGameWithGame(
  options: Partial<PlatformGame> = {},
  game: Partial<Game> = {
    id: 'game-1',
    title: 'Wingspan',
  },
): PlatformGame & { game: Partial<Game> } {
  const platformGame = makePlatformGame('game-1', 'plat-1', options);
  return {
    ...platformGame,
    game: {
      ...game,
    },
  };
}
