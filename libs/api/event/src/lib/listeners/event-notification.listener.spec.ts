import {
  EventParticipationStatus,
  Game,
  NominationStatus,
  NotificationType,
  OccurrenceStatus,
  PlatformGame,
  SystemRole,
} from '@bge/database';
import { NotificationsService } from '@bge/notifications-service';
import {
  createTestingModuleWithDb,
  makeEvent,
  makeEventAttendee,
  makeHouseholdMember,
  makePlatformGame,
  MockDatabaseService,
} from '@bge/testing';
import {
  AttendeeAddedEvent,
  AttendeeRemovedEvent,
  AttendeeStatusUpdatedEvent,
} from '../attendee/events/attendee.events';
import { EventCreatedEvent, EventDeletedEvent } from '../events/event.events';
import { EventCancelledEvent, EventReopenedEvent } from '../lifecycle/events/event-lifecycle.events';
import { NominationCreatedEvent, NominationResolvedEvent } from '../nomination/events/nomination.events';
import { OccurrenceStatusChangedEvent } from '../occurrence/events/occurrence.events';
import { EventNotificationListener } from './event-notification.listener';

const makeCreatedEvent = (overrides: Partial<Parameters<typeof makeEvent>[0]> = {}, invitedUserIds: string[] = []) =>
  new EventCreatedEvent(
    makeEvent({ id: 'ev-1', title: 'Game Night', createdById: 'user-creator', householdId: 'hh-1', ...overrides }),
    invitedUserIds,
    new Date(),
  );

/** The cancel snapshot's columns other than the cancel itself (#795). */
const cancelColumns = { id: 'ev-1', title: 'Game Night', householdId: null };

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
        null,
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
        null,
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
          nominatedBy: { userId: 'user-nominator', removedAt: null },
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

    // A nomination of someone else's game outlives its nominator's removal
    // (#551), but the removed user hears nothing more from the event.
    it('does not notify a nominator a host has removed', async () => {
      db.eventGameNomination.findUnique.mockResolvedValue({
        nominatedById: 'att-1',
        nominatedBy: { userId: 'user-nominator', removedAt: new Date() },
        platformGame: { game: { title: 'Wingspan' } },
        platformGameId: 'plat-game-1',
      } as never);

      await listener.onNominationResolved(makeResolvedEvent(NominationStatus.Passed));

      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  /**
   * #802. An RSVP tells the event's hosts and co-hosts who were not removed,
   * minus the person acting. The creator has no part in it, and nobody hosting
   * means nobody is told.
   */
  describe('onAttendeeRsvp', () => {
    const rsvp = (userId: string | null, actingUserId: string | null) =>
      new AttendeeStatusUpdatedEvent(
        { id: 'att-1', eventId: 'ev-1', userId, status: EventParticipationStatus.Invited },
        { id: 'att-1', eventId: 'ev-1', userId, status: EventParticipationStatus.Attending },
        actingUserId,
        new Date(),
      );

    beforeEach(() => {
      db.event.findUnique.mockResolvedValue(makeEvent({ id: 'ev-1', title: 'Game Night', createdById: 'u-creator' }));
      db.user.findUnique.mockResolvedValue({ username: 'ada', profile: { displayName: 'Ada' } } as never);
    });

    it('tells the hosts and co-hosts, not the creator (#802)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([{ userId: 'u-host' }, { userId: 'u-cohost' }] as never);

      await listener.onAttendeeRsvp(rsvp('u-invitee', 'u-invitee'));

      expect(db.eventAttendee.findMany).toHaveBeenCalledWith({
        where: {
          eventId: 'ev-1',
          removedAt: null,
          userId: { not: null },
          role: { is: { role: { is: { name: { in: [SystemRole.EventHost, SystemRole.EventCoHost] } } } } },
        },
        select: { userId: true },
      });
      expect(notifications.createMany).toHaveBeenCalledWith([
        {
          userId: 'u-host',
          type: NotificationType.EventRsvpReceived,
          payload: { eventId: 'ev-1', eventTitle: 'Game Night', attendeeName: 'Ada' },
        },
        {
          userId: 'u-cohost',
          type: NotificationType.EventRsvpReceived,
          payload: { eventId: 'ev-1', eventTitle: 'Game Night', attendeeName: 'Ada' },
        },
      ]);
    });

    it('leaves out the host who changed the RSVP (#802)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([{ userId: 'u-host' }, { userId: 'u-cohost' }] as never);

      await listener.onAttendeeRsvp(rsvp('u-host', 'u-host'));

      expect(notifications.createMany).toHaveBeenCalledWith([expect.objectContaining({ userId: 'u-cohost' })]);
    });

    it('sends the RSVP of an attendee without an account with no name (#802)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([{ userId: 'u-host' }] as never);

      await listener.onAttendeeRsvp(rsvp(null, 'u-cohost'));

      expect(db.user.findUnique).not.toHaveBeenCalled();
      expect(notifications.createMany).toHaveBeenCalledWith([
        expect.objectContaining({
          userId: 'u-host',
          payload: { eventId: 'ev-1', eventTitle: 'Game Night', attendeeName: null },
        }),
      ]);
    });

    it('tells nobody when the event has no host (#802)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([]);

      await listener.onAttendeeRsvp(rsvp('u-invitee', 'u-invitee'));

      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    // The status is required on every write, so a host editing only the
    // attendee's notes sends the same RSVP again.
    it('tells nobody when the RSVP is sent again unchanged (#802)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([{ userId: 'u-host' }] as never);
      const attending = { id: 'att-1', eventId: 'ev-1', userId: 'u-a', status: EventParticipationStatus.Attending };

      await listener.onAttendeeRsvp(new AttendeeStatusUpdatedEvent(attending, attending, 'u-cohost', new Date()));

      expect(db.eventAttendee.findMany).not.toHaveBeenCalled();
      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    // Every user has a username, so a missing name is a user deleted since the RSVP.
    it("tells nobody when the attendee's user is gone (#802)", async () => {
      db.eventAttendee.findMany.mockResolvedValue([{ userId: 'u-host' }] as never);
      db.user.findUnique.mockResolvedValue(null);

      await listener.onAttendeeRsvp(rsvp('u-a', 'u-cohost'));

      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    it('tells a host once when two rows name them (#802)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([{ userId: 'u-host' }, { userId: 'u-host' }] as never);

      await listener.onAttendeeRsvp(rsvp('u-invitee', 'u-invitee'));

      expect(notifications.createMany).toHaveBeenCalledWith([expect.objectContaining({ userId: 'u-host' })]);
    });

    it('tells the attendee when someone else changed their RSVP (#802)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([{ userId: 'u-host' }] as never);

      await listener.onAttendeeRsvp(rsvp('u-a', 'u-host'));

      expect(notifications.createMany).toHaveBeenCalledWith(
        expect.arrayContaining([
          {
            userId: 'u-a',
            type: NotificationType.EventRsvpChanged,
            payload: {
              eventId: 'ev-1',
              eventTitle: 'Game Night',
              status: EventParticipationStatus.Attending,
              changedByName: 'Ada',
            },
          },
        ]),
      );
    });

    it('names nobody as the changer when the actor is not a user (#802)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([]);

      await listener.onAttendeeRsvp(rsvp('u-a', null));

      expect(notifications.createMany).toHaveBeenCalledWith([
        expect.objectContaining({
          userId: 'u-a',
          type: NotificationType.EventRsvpChanged,
          payload: expect.objectContaining({ changedByName: null }),
        }),
      ]);
    });

    it('does not tell the attendee of their own RSVP (#802)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([{ userId: 'u-host' }] as never);

      await listener.onAttendeeRsvp(rsvp('u-a', 'u-a'));

      const types = notifications.createMany.mock.calls.flatMap(([inputs]) => inputs.map((input) => input.type));
      expect(types).not.toContain(NotificationType.EventRsvpChanged);
    });

    it('tells a host whose RSVP someone else changed once, as the attendee (#802)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([{ userId: 'u-host' }, { userId: 'u-cohost' }] as never);

      await listener.onAttendeeRsvp(rsvp('u-cohost', 'u-host'));

      expect(notifications.createMany).toHaveBeenCalledTimes(1);
      expect(notifications.createMany).toHaveBeenCalledWith([
        expect.objectContaining({ userId: 'u-cohost', type: NotificationType.EventRsvpChanged }),
      ]);
    });

    it('tells nobody that the RSVP of an attendee without an account changed (#802)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([{ userId: 'u-host' }, { userId: 'u-cohost' }] as never);

      await listener.onAttendeeRsvp(rsvp(null, 'u-host'));

      const types = notifications.createMany.mock.calls.flatMap(([inputs]) => inputs.map((input) => input.type));
      expect(types).toEqual([NotificationType.EventRsvpReceived]);
    });
  });

  /**
   * #802, #677. A date's confirm, decline or cancel tells every attendee not
   * removed who has not answered not attending, whether or not they voted,
   * minus the person acting.
   */
  describe('date status changes', () => {
    const change = (actingUserId: string | null) =>
      new OccurrenceStatusChangedEvent(
        { id: 'occ-1', eventId: 'ev-1', status: OccurrenceStatus.Proposed },
        { id: 'occ-1', eventId: 'ev-1', status: OccurrenceStatus.Confirmed },
        { occurrenceLabel: 'Saturday evening', actingUserId },
        new Date(),
      );

    beforeEach(() => {
      db.event.findUnique.mockResolvedValue(makeEvent({ id: 'ev-1', title: 'Game Night', createdById: 'u-creator' }));
    });

    it('tells the attendees still coming, whether or not they voted (#802)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([{ userId: 'user-a' }, { userId: 'user-b' }] as never);

      await listener.onOccurrenceConfirmed(change('user-host'));

      expect(db.eventAttendee.findMany).toHaveBeenCalledWith({
        where: {
          eventId: 'ev-1',
          removedAt: null,
          userId: { not: null },
          status: { not: EventParticipationStatus.NotAttending },
        },
        select: { userId: true },
      });
      expect(db.eventAvailabilityVote.findMany).not.toHaveBeenCalled();
      expect(notifications.createMany).toHaveBeenCalledWith(
        ['user-a', 'user-b'].map((userId) => ({
          userId,
          type: NotificationType.EventOccurrenceConfirmed,
          payload: {
            eventId: 'ev-1',
            eventTitle: 'Game Night',
            occurrenceId: 'occ-1',
            occurrenceLabel: 'Saturday evening',
          },
        })),
      );
    });

    it('leaves out the person acting, not the creator (#802)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([{ userId: 'u-creator' }, { userId: 'user-host' }] as never);

      await listener.onOccurrenceDeclined(change('user-host'));

      expect(notifications.createMany).toHaveBeenCalledWith([
        expect.objectContaining({ userId: 'u-creator', type: NotificationType.EventOccurrenceDeclined }),
      ]);
    });

    it("notifies when the date's row is already gone (#677)", async () => {
      db.eventAttendee.findMany.mockResolvedValue([{ userId: 'user-a' }] as never);

      await listener.onOccurrenceCancelled(change('user-host'));

      expect(db.eventOccurrence.findUnique).not.toHaveBeenCalled();
      expect(notifications.createMany).toHaveBeenCalledWith([
        expect.objectContaining({
          userId: 'user-a',
          type: NotificationType.EventOccurrenceCanceled,
          payload: expect.objectContaining({ occurrenceLabel: 'Saturday evening' }),
        }),
      ]);
    });

    it('notifies each user once (#802)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([{ userId: 'user-a' }, { userId: 'user-a' }] as never);

      await listener.onOccurrenceConfirmed(change('user-host'));

      expect(notifications.createMany).toHaveBeenCalledWith([expect.objectContaining({ userId: 'user-a' })]);
    });

    it('still tells everyone when a plugin or system confirmed the date (#802)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([{ userId: 'user-a' }, { userId: 'user-host' }] as never);

      await listener.onOccurrenceConfirmed(change(null));

      expect(notifications.createMany).toHaveBeenCalledWith([
        expect.objectContaining({ userId: 'user-a' }),
        expect.objectContaining({ userId: 'user-host' }),
      ]);
    });

    it('warns and sends nothing when the event is gone (#677)', async () => {
      db.event.findUnique.mockResolvedValue(null);

      await listener.onOccurrenceConfirmed(change('user-host'));

      expect(notifications.createMany).not.toHaveBeenCalled();
    });
  });

  /**
   * #795. A cancel or a reopen tells every attendee not removed, whatever
   * their RSVP, Invited and Declined included, except the person acting.
   * Guests without an account have nobody to tell.
   */
  describe.each([
    {
      name: 'onEventCancelled',
      type: NotificationType.EventCancelled,
      run: (actingUserId: string) =>
        listener.onEventCancelled(
          new EventCancelledEvent(
            { ...cancelColumns, cancelledAt: null, cancelledById: null, cancelReason: null },
            { ...cancelColumns, cancelledAt: new Date(), cancelledById: actingUserId, cancelReason: 'rain' },
            actingUserId,
            new Date(),
          ),
        ),
      payload: { eventId: 'ev-1', eventTitle: 'Game Night', reason: 'rain' },
    },
    {
      name: 'onEventReopened',
      type: NotificationType.EventReopened,
      run: (actingUserId: string) =>
        listener.onEventReopened(
          new EventReopenedEvent(
            { ...cancelColumns, cancelledAt: new Date(), cancelledById: 'user-host', cancelReason: 'rain' },
            { ...cancelColumns, cancelledAt: null, cancelledById: null, cancelReason: null },
            actingUserId,
            new Date(),
          ),
        ),
      payload: { eventId: 'ev-1', eventTitle: 'Game Night' },
    },
  ])('$name', ({ type, run, payload }) => {
    it('reads every attendee not removed who has an account, whatever their RSVP (#795)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([]);

      await run('user-host');

      expect(db.eventAttendee.findMany).toHaveBeenCalledWith({
        where: { eventId: 'ev-1', removedAt: null, userId: { not: null } },
        select: { userId: true },
      });
    });

    it('tells each of them once, and not the person acting (#795)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([
        { userId: 'user-host' },
        { userId: 'user-invited' },
        { userId: 'user-declined' },
        { userId: 'user-invited' },
      ] as never);

      await run('user-host');

      expect(notifications.createMany).toHaveBeenCalledTimes(1);
      expect(notifications.createMany).toHaveBeenCalledWith([
        { userId: 'user-invited', type, payload },
        { userId: 'user-declined', type, payload },
      ]);
    });

    it('creates nothing when nobody else attends (#795)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([{ userId: 'user-host' }] as never);

      await run('user-host');

      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    it('logs a failed read rather than throwing it (#795)', async () => {
      db.eventAttendee.findMany.mockRejectedValue(new Error('db down'));

      await expect(run('user-host')).resolves.toBeUndefined();
      expect(notifications.createMany).not.toHaveBeenCalled();
    });
  });

  /**
   * #802. A deleted event tells the attendees who were not removed, except the
   * person deleting it. The title rides the domain event, which is already gone.
   */
  describe('onEventDeleted', () => {
    it('tells the attendees not removed, except the person deleting it (#802)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([
        { userId: 'u-host' },
        { userId: 'u-a' },
        { userId: 'u-b' },
      ] as never);

      await listener.onEventDeleted(
        new EventDeletedEvent(
          { id: 'ev-1', title: 'Game Night', createdById: 'u-host', householdId: null },
          'u-host',
          new Date(),
        ),
      );

      expect(db.event.findUnique).not.toHaveBeenCalled();
      expect(db.eventAttendee.findMany).toHaveBeenCalledWith({
        where: { eventId: 'ev-1', removedAt: null, userId: { not: null } },
        select: { userId: true },
      });
      expect(notifications.createMany).toHaveBeenCalledWith([
        {
          userId: 'u-a',
          type: NotificationType.EventDeleted,
          payload: { eventId: 'ev-1', eventTitle: 'Game Night' },
        },
        {
          userId: 'u-b',
          type: NotificationType.EventDeleted,
          payload: { eventId: 'ev-1', eventTitle: 'Game Night' },
        },
      ]);
    });
  });

  /**
   * #802. A removed attendee is told, unless they removed themselves. An
   * attendee without an account has nobody to tell.
   */
  describe('onAttendeeRemoved', () => {
    const removal = (userId: string | null, actingUserId: string) => {
      const snapshot = {
        id: 'att-1',
        eventId: 'ev-1',
        userId,
        guestName: null,
        status: EventParticipationStatus.Attending,
      };

      return new AttendeeRemovedEvent(
        { ...snapshot, removedAt: null },
        { ...snapshot, removedAt: new Date() },
        actingUserId,
        new Date(),
      );
    };

    beforeEach(() => {
      db.event.findUnique.mockResolvedValue(makeEvent({ id: 'ev-1', title: 'Game Night' }));
    });

    it('tells the person removed (#802)', async () => {
      await listener.onAttendeeRemoved(removal('u-a', 'u-host'));

      expect(notifications.create).toHaveBeenCalledWith({
        userId: 'u-a',
        type: NotificationType.EventAttendeeRemoved,
        payload: { eventId: 'ev-1', eventTitle: 'Game Night' },
      });
    });

    it('tells nobody when an attendee without an account is removed (#802)', async () => {
      await listener.onAttendeeRemoved(removal(null, 'u-host'));

      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('tells nobody when the person removed is the one acting (#802)', async () => {
      await listener.onAttendeeRemoved(removal('u-host', 'u-host'));

      expect(notifications.create).not.toHaveBeenCalled();
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
