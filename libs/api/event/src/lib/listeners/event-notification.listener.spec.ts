import type { Game, PlatformGame } from '@bge/database';
import {
  EventParticipationStatus,
  InviteStatus,
  InviteType,
  NominationStatus,
  NotificationType,
  OccurrenceStatus,
  ScheduledGameRole,
  SystemRole,
} from '@bge/database';
import type { InviteSnapshot } from '@bge/invites';
import { InviteAcceptedEvent, InviteCreatedEvent, InviteDeclinedEvent } from '@bge/invites';
import { LineupRemovalReason, NotificationsService } from '@bge/notifications-service';
import type { MockDatabaseService } from '@bge/testing';
import {
  createTestingModuleWithDb,
  makeEvent,
  makeEventAttendee,
  makeHouseholdMember,
  makePlatformGame,
} from '@bge/testing';
import { Logger } from '@nestjs/common';
import { AttendeeEvents } from '../attendee/constants';
import { AttendeeRemovedEvent, AttendeeStatusUpdatedEvent } from '../attendee/events/attendee.events';
import { EventCreatedEvent, EventDeletedEvent } from '../events/event.events';
import { receivedEventInviteWhere } from '../invite/received-event-invites';
import { EventCancelledEvent, EventReopenedEvent } from '../lifecycle/events/event-lifecycle.events';
import {
  GameAddedToEventEvent,
  GameRemovedFromEventEvent,
  NominationCreatedEvent,
  NominationResolvedEvent,
} from '../nomination/events/nomination.events';
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
    it('sends no EventInviteReceived for a venue-based event: the invites announce themselves (#742)', async () => {
      await listener.onEventCreated(makeCreatedEvent({ householdId: null }, ['user-friend-1']));

      expect(db.householdMember.findMany).not.toHaveBeenCalled();
      expect(notifications.createMany).not.toHaveBeenCalled();
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

    it('leaves invited users out of the household fan-out and tells them nothing itself (#742)', async () => {
      db.householdMember.findMany.mockResolvedValue([
        makeHouseholdMember({ userId: 'user-a', householdId: 'hh-1' }), // not invited, so told of the event
      ]);

      await listener.onEventCreated(makeCreatedEvent({}, ['user-b']));

      // The invitee hears of the event from invite.created, once; the
      // household's fan-out must not tell them as a household member as well.
      expect(db.householdMember.findMany).toHaveBeenCalledWith({
        where: { householdId: 'hh-1', userId: { notIn: ['user-creator', 'user-b'] } },
        select: { userId: true },
      });
      expect(notifications.createMany).toHaveBeenCalledWith([
        expect.objectContaining({ userId: 'user-a', type: NotificationType.EventCreated }),
      ]);
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

  describe('AttendeeAdded', () => {
    it('sends no invite notice: an add is by name or an accepted invite, and the invite told its invitee (#742)', () => {
      // `@OnEvent` records each handler's event names on the method. None may
      // be the attendee add, which once announced an invite the add no longer is.
      const listened = Object.getOwnPropertyNames(EventNotificationListener.prototype).flatMap(
        (name): string[] =>
          Reflect.getMetadata('EVENT_LISTENER_METADATA', Reflect.get(EventNotificationListener.prototype, name)) ?? [],
      );

      expect(listened).not.toHaveLength(0);
      expect(JSON.stringify(listened)).not.toContain(AttendeeEvents.AttendeeAdded);
    });
  });

  describe('event invites (#742)', () => {
    const NOW = new Date('2026-11-25T12:00:00Z');
    const INVITER_ID = 'user-riley';
    const INVITEE_ID = 'user-sam';

    /** An event invite to Sam by id, from Riley, as the lib's events carry it. */
    const snapshot = (overrides: Partial<InviteSnapshot> = {}): InviteSnapshot => ({
      id: 'invite-1',
      type: InviteType.Event,
      status: InviteStatus.Pending,
      inviterId: INVITER_ID,
      inviteeId: INVITEE_ID,
      inviteeName: 'Sam',
      inviteeEmail: null,
      householdId: null,
      eventId: 'ev-1',
      roleId: 'role-participant',
      expiresAt: new Date('2026-12-25T12:00:00Z'),
      respondedAt: null,
      ...overrides,
    });

    const created = (overrides: Partial<InviteSnapshot> = {}) => new InviteCreatedEvent(snapshot(overrides), NOW);

    const responded = (status: InviteStatus, overrides: Partial<InviteSnapshot> = {}) =>
      [snapshot(overrides), snapshot({ ...overrides, status, respondedAt: NOW }), NOW] as const;

    const accepted = (overrides: Partial<InviteSnapshot> = {}) =>
      new InviteAcceptedEvent(...responded(InviteStatus.Accepted, overrides));

    const declined = (overrides: Partial<InviteSnapshot> = {}) =>
      new InviteDeclinedEvent(...responded(InviteStatus.Declined, overrides));

    /** The user rows the names are read from. */
    const knowUsers = () =>
      db.user.findUnique.mockImplementation((async ({ where }: { where: { id: string } }) =>
        where.id === INVITER_ID
          ? { username: 'riley', profile: { displayName: 'Riley' } }
          : { username: 'sam', profile: { displayName: '' } }) as never);

    beforeEach(() => {
      db.event.findUnique.mockResolvedValue(makeEvent({ id: 'ev-1', title: 'Game Night' }));
      knowUsers();
    });

    afterEach(() => jest.useRealTimers());

    describe('invite.created', () => {
      it('tells the invitee, when their inbox lists the invite, naming the event and the inviter (#742)', async () => {
        db.invite.count.mockResolvedValue(1);
        jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'queueMicrotask'] });

        await listener.onInviteCreated(created());

        // The inbox's own predicate is asked about this one invite.
        expect(db.invite.count).toHaveBeenCalledWith({
          where: { id: 'invite-1', AND: [receivedEventInviteWhere(INVITEE_ID, NOW)] },
        });
        expect(notifications.create).toHaveBeenCalledWith({
          userId: INVITEE_ID,
          type: NotificationType.EventInviteReceived,
          payload: { eventId: 'ev-1', eventTitle: 'Game Night', inviteId: 'invite-1', inviterName: 'Riley' },
        });
      });

      it('tells nobody of an invite their inbox does not list, such as a withheld one (#742)', async () => {
        db.invite.count.mockResolvedValue(0);

        await listener.onInviteCreated(created());

        expect(notifications.create).not.toHaveBeenCalled();
      });

      it("tells nobody of a household invite, which is the household listener's (#742)", async () => {
        await listener.onInviteCreated(created({ type: InviteType.Household, householdId: 'hh-1', eventId: null }));

        expect(db.invite.count).not.toHaveBeenCalled();
        expect(notifications.create).not.toHaveBeenCalled();
      });

      it('tells nobody of an event invite that names no user (#742)', async () => {
        await listener.onInviteCreated(created({ inviteeId: null }));

        expect(notifications.create).not.toHaveBeenCalled();
      });

      it('never throws when the write fails, and logs it (#742)', async () => {
        const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
        db.invite.count.mockRejectedValue(new Error('db down'));

        await expect(listener.onInviteCreated(created())).resolves.toBeUndefined();

        expect(error).toHaveBeenCalled();
      });
    });

    describe('invite.accepted and invite.declined', () => {
      it('tells the inviter of an accept, naming the invitee (#742)', async () => {
        await listener.onInviteAccepted(accepted());

        expect(notifications.create).toHaveBeenCalledWith({
          userId: INVITER_ID,
          type: NotificationType.EventInviteAccepted,
          payload: { eventId: 'ev-1', eventTitle: 'Game Night', inviteId: 'invite-1', inviteeName: 'sam' },
        });
      });

      it('tells the inviter of a decline, naming the invitee (#742)', async () => {
        await listener.onInviteDeclined(declined());

        expect(notifications.create).toHaveBeenCalledWith({
          userId: INVITER_ID,
          type: NotificationType.EventInviteDeclined,
          payload: { eventId: 'ev-1', eventTitle: 'Game Night', inviteId: 'invite-1', inviteeName: 'sam' },
        });
      });

      it('does not tell the inviter of their own answer (#742)', async () => {
        await listener.onInviteAccepted(accepted({ inviterId: INVITEE_ID }));
        await listener.onInviteDeclined(declined({ inviterId: INVITEE_ID }));

        expect(notifications.create).not.toHaveBeenCalled();
      });

      it('tells nobody of a household invite answered (#742)', async () => {
        const household = { type: InviteType.Household, householdId: 'hh-1', eventId: null };

        await listener.onInviteAccepted(accepted(household));
        await listener.onInviteDeclined(declined(household));

        expect(notifications.create).not.toHaveBeenCalled();
      });

      it('tells nobody once the event is gone, and never throws (#742)', async () => {
        db.event.findUnique.mockResolvedValue(null);

        await expect(listener.onInviteAccepted(accepted())).resolves.toBeUndefined();

        expect(notifications.create).not.toHaveBeenCalled();
      });
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

    // "Your nomination failed" misleads when everyone who voted voted For: too
    // few voted for the result to count, and the type is how the client says so.
    it('notifies the nominator with GameNominationQuorumNotMet when too few voted (#798)', async () => {
      await listener.onNominationResolved(makeResolvedEvent(NominationStatus.QuorumNotMet, null));

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.GameNominationQuorumNotMet,
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

    it('names the attendee by their username when they have no display name (#802)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([{ userId: 'u-host' }] as never);
      db.user.findUnique.mockResolvedValue({ username: 'ada', profile: null } as never);

      await listener.onAttendeeRsvp(rsvp('u-a', 'u-a'));

      expect(notifications.createMany).toHaveBeenCalledWith([
        expect.objectContaining({ userId: 'u-host', payload: expect.objectContaining({ attendeeName: 'ada' }) }),
      ]);
    });

    it('warns and tells nobody when the event is gone (#802)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([{ userId: 'u-host' }] as never);
      db.event.findUnique.mockResolvedValue(null);

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

    it('tells nobody when the person acting is the only one still coming (#802)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([{ userId: 'user-host' }] as never);

      await listener.onOccurrenceConfirmed(change('user-host'));

      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    // The read asks only for rows with an account; an attendee without one
    // has nobody to tell, whatever the read hands back.
    it('never addresses an attendee without an account (#802)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([{ userId: 'user-a' }, { userId: null }] as never);

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

    it('warns and tells nobody when the event is gone (#802)', async () => {
      db.event.findUnique.mockResolvedValue(null);

      await listener.onAttendeeRemoved(removal('u-a', 'u-host'));

      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('logs a failed write rather than throwing it (#802)', async () => {
      notifications.create.mockRejectedValue(new Error('db down'));

      await expect(listener.onAttendeeRemoved(removal('u-a', 'u-host'))).resolves.toBeUndefined();
    });
  });

  describe('onGameRemoved', () => {
    const removal = (reason: LineupRemovalReason, actingUserId: string | null, occurrenceId: string | null = null) =>
      new GameRemovedFromEventEvent(
        {
          id: 'lg-1',
          eventId: occurrenceId ? null : 'ev-1',
          occurrenceId,
          platformGameId: 'pg-1',
          suppliedById: 'att-supplier',
          nominationId: null,
          addedById: 'att-host',
          role: ScheduledGameRole.Primary,
        },
        'ev-1',
        reason,
        actingUserId,
        new Date(),
      );

    beforeEach(() => {
      db.event.findUnique.mockResolvedValue(makeEvent({ id: 'ev-1', title: 'Game Night' }));
      db.platformGame.findUnique.mockResolvedValue(
        stubPlatformGameWithGame({ id: 'pg-1' }, { id: 'game-1', title: 'Wingspan', subtitle: 'Asia' }) as never,
      );
    });

    it.each([
      [LineupRemovalReason.TakenOut, 'user-host', null],
      [LineupRemovalReason.SupplierLeft, 'user-supplier', null],
      [LineupRemovalReason.NobodyBringing, 'user-host', 'occ-1'],
      [LineupRemovalReason.RemovedFromCollection, 'user-supplier', null],
    ] as const)(
      'tells the attendees still coming, minus whoever acted, that a game left the lineup, with its reason: %s (#769)',
      async (reason, actingUserId, occurrenceId) => {
        db.eventAttendee.findMany.mockResolvedValue([
          { userId: 'user-a' },
          { userId: actingUserId },
          { userId: 'user-b' },
        ] as never);

        await listener.onGameRemoved(removal(reason, actingUserId, occurrenceId));

        expect(db.eventAttendee.findMany).toHaveBeenCalledWith({
          where: {
            eventId: 'ev-1',
            removedAt: null,
            userId: { not: null },
            status: { not: EventParticipationStatus.NotAttending },
          },
          select: { userId: true },
        });
        expect(notifications.createMany).toHaveBeenCalledWith(
          ['user-a', 'user-b'].map((userId) => ({
            userId,
            type: NotificationType.GameRemovedFromEvent,
            payload: {
              eventId: 'ev-1',
              eventTitle: 'Game Night',
              lineupGameId: 'lg-1',
              occurrenceId,
              gameTitle: 'Wingspan',
              // Two editions can share a title (#1271).
              gameSubtitle: 'Asia',
              reason,
            },
          })),
        );
      },
    );

    it('still tells everyone when the actor is not a user (#769)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([{ userId: 'user-a' }, { userId: 'user-b' }] as never);

      await listener.onGameRemoved(removal(LineupRemovalReason.NobodyBringing, null, 'occ-1'));

      expect(notifications.createMany).toHaveBeenCalledWith([
        expect.objectContaining({ userId: 'user-a' }),
        expect.objectContaining({ userId: 'user-b' }),
      ]);
    });

    it("tells nobody when the event or the game can't be found, and logs it (#769)", async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      db.platformGame.findUnique.mockResolvedValue(null);

      await listener.onGameRemoved(removal(LineupRemovalReason.TakenOut, 'user-host'));

      expect(notifications.createMany).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('eventId=ev-1'));
      warn.mockRestore();
    });

    it('tells nobody when the person acting is the only one still coming (#769)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([{ userId: 'user-host' }] as never);

      await listener.onGameRemoved(removal(LineupRemovalReason.TakenOut, 'user-host'));

      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    // The removal has committed by the time this runs, so a failed write is
    // logged, never thrown back into the emit.
    it('logs a failed write rather than throwing it (#769)', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      db.eventAttendee.findMany.mockResolvedValue([{ userId: 'user-a' }] as never);
      notifications.createMany.mockRejectedValue(new Error('db down'));

      await expect(listener.onGameRemoved(removal(LineupRemovalReason.TakenOut, 'user-host'))).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('lineupGameId=lg-1'), expect.any(String));
      error.mockRestore();
    });
  });

  describe('onGameAdded', () => {
    const addition = (occurrenceId: string | null = null) =>
      new GameAddedToEventEvent(
        {
          id: 'lg-1',
          eventId: occurrenceId ? null : 'ev-1',
          occurrenceId,
          platformGameId: 'pg-1',
          suppliedById: 'att-supplier',
          nominationId: null,
          addedById: 'att-host',
          role: ScheduledGameRole.Primary,
        },
        'ev-1',
        'att-host',
        new Date(),
      );

    beforeEach(() => {
      db.event.findUnique.mockResolvedValue(makeEvent({ id: 'ev-1', title: 'Game Night' }));
      db.platformGame.findUnique.mockResolvedValue(
        stubPlatformGameWithGame({ id: 'pg-1' }, { id: 'game-1', title: 'Wingspan', subtitle: 'Asia' }) as never,
      );
    });

    // A date's game names its event through the context field, the row's own
    // eventId being null, so both read the same event.
    it.each([null, 'occ-1'])(
      'tells every attendee with an account except whoever added it, naming the game with its subtitle (occurrenceId %s) (#1271)',
      async (occurrenceId) => {
        db.eventAttendee.findMany.mockResolvedValue([
          { id: 'att-a', userId: 'user-a' },
          { id: 'att-host', userId: 'user-host' },
          { id: 'att-b', userId: 'user-b' },
        ] as never);

        await listener.onGameAdded(addition(occurrenceId));

        expect(db.event.findUnique).toHaveBeenCalledWith({ where: { id: 'ev-1' }, select: { title: true } });
        expect(db.platformGame.findUnique).toHaveBeenCalledWith({
          where: { id: 'pg-1' },
          select: { id: true, game: { select: { title: true, subtitle: true } } },
        });
        expect(db.eventAttendee.findMany).toHaveBeenCalledWith({
          where: { eventId: 'ev-1', userId: { not: null }, removedAt: null },
          select: { userId: true, id: true },
        });
        expect(notifications.createMany).toHaveBeenCalledWith(
          ['user-a', 'user-b'].map((userId) => ({
            userId,
            type: NotificationType.GameAddedToEvent,
            payload: {
              eventId: 'ev-1',
              eventTitle: 'Game Night',
              nominatedGameTitle: 'Wingspan',
              // Two editions can share a title (#1271).
              nominatedGameSubtitle: 'Asia',
            },
          })),
        );
      },
    );

    it("tells nobody when the event or the game can't be found, and logs it (#1271)", async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      db.event.findUnique.mockResolvedValue(null);

      await listener.onGameAdded(addition());

      expect(db.eventAttendee.findMany).not.toHaveBeenCalled();
      expect(notifications.createMany).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('GameAddedToEvent notification, eventId=ev-1'));
      warn.mockRestore();
    });

    it('tells nobody when whoever added it is the only attendee with an account (#1271)', async () => {
      db.eventAttendee.findMany.mockResolvedValue([{ id: 'att-host', userId: 'user-host' }] as never);

      await listener.onGameAdded(addition());

      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    it('logs a failed write rather than throwing it (#1271)', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      db.eventAttendee.findMany.mockResolvedValue([{ id: 'att-a', userId: 'user-a' }] as never);
      notifications.createMany.mockRejectedValue(new Error('db down'));

      await expect(listener.onGameAdded(addition())).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('GameAddedToEvent eventId=ev-1'), expect.any(String));
      error.mockRestore();
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
