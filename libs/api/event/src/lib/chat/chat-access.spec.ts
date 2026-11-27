import type { Actor } from '@bge/actor-context';
import { SERVER_PLUGIN_UNIT } from '@bge/actor-context';
import type { Prisma } from '@bge/database';
import {
  EventChatAccess,
  EventParticipationStatus,
  ROLE_PERMISSION_CATALOG,
  ROLE_SCOPE,
  SystemRole,
} from '@bge/database';
import type { MockDatabaseService } from '@bge/testing';
import { createMockDatabaseService } from '@bge/testing';
import { CHAT_MODERATING_ROLES, chatAccess, decideChatAccess } from './chat-access';
import type { ChatFacts, ChatPolicy } from './chat-facts';

const NOW = new Date('2026-11-26T12:00:00.000Z');

const { AllAttendees, Responded, MaybeOrAttending, Attending: AttendingOnly } = EventChatAccess;
const { Invited, NotAttending, Maybe, Attending } = EventParticipationStatus;

const policy = (overrides: Partial<ChatPolicy> = {}): ChatPolicy => ({
  chatEnabled: true,
  chatReadAccess: AllAttendees,
  chatPostAccess: AllAttendees,
  chatSpectatorsMayPost: false,
  ...overrides,
});

/** An attending participant of a live event, under the event policy's default chat controls, with no host mute. */
const facts = (overrides: Partial<ChatFacts> = {}): ChatFacts => ({
  attendeeId: 'attendee-1',
  status: Attending,
  role: SystemRole.EventParticipant,
  cancelledAt: null,
  archivedAt: null,
  policy: policy(),
  hostMutedAt: null,
  hostMutedUntil: null,
  ...overrides,
});

const MODERATING_ROLES = [SystemRole.EventHost, SystemRole.EventCoHost, SystemRole.EventModerator];

/**
 * Which RSVPs each chat access level admits (#1544), written out for every
 * pair rather than derived, so the table is the specification the decision is
 * held to.
 */
const ADMITTED: readonly [EventChatAccess, EventParticipationStatus, boolean][] = [
  [AllAttendees, Invited, true],
  [AllAttendees, NotAttending, true],
  [AllAttendees, Maybe, true],
  [AllAttendees, Attending, true],
  [Responded, Invited, false],
  [Responded, NotAttending, true],
  [Responded, Maybe, true],
  [Responded, Attending, true],
  [MaybeOrAttending, Invited, false],
  [MaybeOrAttending, NotAttending, false],
  [MaybeOrAttending, Maybe, true],
  [MaybeOrAttending, Attending, true],
  [AttendingOnly, Invited, false],
  [AttendingOnly, NotAttending, false],
  [AttendingOnly, Maybe, false],
  [AttendingOnly, Attending, true],
];

describe('decideChatAccess (#1543, #1544)', () => {
  it('lets an attending participant read and post, as no moderator', () => {
    expect(decideChatAccess(facts(), NOW)).toEqual({
      canRead: true,
      attendeeId: 'attendee-1',
      moderates: false,
      post: { allowed: true },
    });
  });

  describe('read access, by RSVP', () => {
    it.each(ADMITTED)('at %s, an attendee who is %s reads: %s', (level, status, admitted) => {
      const access = decideChatAccess(facts({ status, policy: policy({ chatReadAccess: level }) }), NOW);

      expect(access).toEqual(
        admitted
          ? expect.objectContaining({ canRead: true })
          : { canRead: false, refusal: 'EVENT_CHAT_READ_NOT_ALLOWED' },
      );
    });
  });

  describe('post access, by RSVP', () => {
    it.each(ADMITTED)('at %s, an attendee who is %s posts: %s', (level, status, admitted) => {
      const access = decideChatAccess(facts({ status, policy: policy({ chatPostAccess: level }) }), NOW);

      expect(access).toEqual(
        expect.objectContaining({
          canRead: true,
          post: admitted
            ? { allowed: true }
            : { allowed: false, refusal: 'EVENT_CHAT_POST_NOT_ALLOWED', mutedUntil: null },
        }),
      );
    });
  });

  describe('spectators', () => {
    it('lets a spectator read but not post while the setting is off', () => {
      expect(decideChatAccess(facts({ role: SystemRole.EventSpectator }), NOW)).toEqual(
        expect.objectContaining({
          canRead: true,
          post: { allowed: false, refusal: 'EVENT_CHAT_POST_NOT_ALLOWED', mutedUntil: null },
        }),
      );
    });

    it('lets a spectator post once the setting is on', () => {
      const access = decideChatAccess(
        facts({ role: SystemRole.EventSpectator, policy: policy({ chatSpectatorsMayPost: true }) }),
        NOW,
      );

      expect(access).toEqual(expect.objectContaining({ canRead: true, post: { allowed: true } }));
    });
  });

  describe('hosts, co-hosts and event moderators', () => {
    it.each(MODERATING_ROLES)('lets a %s who is not attending read and post a chat set to Attending', (role) => {
      const access = decideChatAccess(
        facts({
          role,
          status: NotAttending,
          policy: policy({ chatReadAccess: AttendingOnly, chatPostAccess: AttendingOnly }),
        }),
        NOW,
      );

      expect(access).toEqual({ canRead: true, attendeeId: 'attendee-1', moderates: true, post: { allowed: true } });
    });

    // The roles that moderate are the ones the catalog lets delete anyone's
    // message, so a new moderating role can't be added in one place only.
    it('are the event roles the catalog gives delete:event_chat_message (#1543)', () => {
      const deleters = Object.values(SystemRole).filter(
        (role) => ROLE_SCOPE[role] === 'event' && ROLE_PERMISSION_CATALOG[role].includes('delete:event_chat_message'),
      );

      expect(deleters.length).toBeGreaterThan(0);
      expect([...CHAT_MODERATING_ROLES].sort()).toEqual(deleters.sort());
    });

    // Custom event roles (#1170) carry their own names, so they match none of
    // the moderating roles.
    it.each([
      SystemRole.EventOrganizer,
      SystemRole.EventParticipant,
      SystemRole.EventGuest,
      SystemRole.EventSpectator,
      'ChatCaptain',
    ])('counts a %s as no moderator', (role) => {
      expect(decideChatAccess(facts({ role }), NOW)).toEqual(expect.objectContaining({ moderates: false }));
    });
  });

  describe('chat off', () => {
    it('refuses an attendee', () => {
      expect(decideChatAccess(facts({ policy: policy({ chatEnabled: false }) }), NOW)).toEqual({
        canRead: false,
        refusal: 'EVENT_CHAT_OFF',
      });
    });

    it('refuses a spectator, even one the event lets post', () => {
      const access = decideChatAccess(
        facts({
          role: SystemRole.EventSpectator,
          policy: policy({ chatEnabled: false, chatSpectatorsMayPost: true }),
        }),
        NOW,
      );

      expect(access).toEqual({ canRead: false, refusal: 'EVENT_CHAT_OFF' });
    });

    // Hosts, co-hosts and event moderators always read and post (#1544).
    it.each(MODERATING_ROLES)('lets a %s read and post', (role) => {
      expect(decideChatAccess(facts({ role, policy: policy({ chatEnabled: false }) }), NOW)).toEqual({
        canRead: true,
        attendeeId: 'attendee-1',
        moderates: true,
        post: { allowed: true },
      });
    });

    // Only a cancelled or archived event stops them posting (#1544).
    it.each(MODERATING_ROLES)('leaves a %s read-only on a cancelled event', (role) => {
      const access = decideChatAccess(facts({ role, cancelledAt: NOW, policy: policy({ chatEnabled: false }) }), NOW);

      expect(access).toEqual({
        canRead: true,
        attendeeId: 'attendee-1',
        moderates: true,
        post: { allowed: false, refusal: 'EVENT_CHAT_READ_ONLY', mutedUntil: null },
      });
    });
  });

  describe('a cancelled or archived event', () => {
    it.each([
      ['cancelled', SystemRole.EventParticipant, { cancelledAt: NOW }],
      ['cancelled', SystemRole.EventHost, { cancelledAt: NOW }],
      ['archived', SystemRole.EventParticipant, { archivedAt: NOW }],
      ['archived', SystemRole.EventHost, { archivedAt: NOW }],
    ])('is read-only for a %s event, to a %s too', (_state, role, closed) => {
      expect(decideChatAccess(facts({ role, ...closed }), NOW)).toEqual(
        expect.objectContaining({
          canRead: true,
          post: { allowed: false, refusal: 'EVENT_CHAT_READ_ONLY', mutedUntil: null },
        }),
      );
    });
  });

  describe('host mutes', () => {
    const MUTED_AT = new Date('2026-11-26T10:00:00.000Z');

    it('stops an attendee posting until it is lifted, when it has no end', () => {
      expect(decideChatAccess(facts({ hostMutedAt: MUTED_AT, hostMutedUntil: null }), NOW)).toEqual(
        expect.objectContaining({
          canRead: true,
          post: { allowed: false, refusal: 'EVENT_CHAT_MUTED', mutedUntil: null },
        }),
      );
    });

    it('stops an attendee posting until its end, and names the end', () => {
      const until = new Date('2026-11-26T13:00:00.000Z');

      expect(decideChatAccess(facts({ hostMutedAt: MUTED_AT, hostMutedUntil: until }), NOW)).toEqual(
        expect.objectContaining({
          canRead: true,
          post: { allowed: false, refusal: 'EVENT_CHAT_MUTED', mutedUntil: until },
        }),
      );
    });

    it('no longer mutes once its end has passed', () => {
      const until = new Date('2026-11-26T11:59:59.000Z');

      expect(decideChatAccess(facts({ hostMutedAt: MUTED_AT, hostMutedUntil: until }), NOW)).toEqual(
        expect.objectContaining({ post: { allowed: true } }),
      );
    });

    it('no longer mutes at the very moment it ends', () => {
      expect(decideChatAccess(facts({ hostMutedAt: MUTED_AT, hostMutedUntil: new Date(NOW) }), NOW)).toEqual(
        expect.objectContaining({ post: { allowed: true } }),
      );
    });

    it.each(MODERATING_ROLES)('never stops a %s posting', (role) => {
      expect(decideChatAccess(facts({ role, hostMutedAt: MUTED_AT, hostMutedUntil: null }), NOW)).toEqual(
        expect.objectContaining({ moderates: true, post: { allowed: true } }),
      );
    });

    // The mute is checked last: a reader who couldn't post anyway is told
    // why, with no mute end to wait for (#1543).
    it('leaves a muted spectator refused as a spectator, while the setting is off', () => {
      const until = new Date('2026-11-26T13:00:00.000Z');
      const access = decideChatAccess(
        facts({ role: SystemRole.EventSpectator, hostMutedAt: MUTED_AT, hostMutedUntil: until }),
        NOW,
      );

      expect(access).toEqual(
        expect.objectContaining({
          canRead: true,
          post: { allowed: false, refusal: 'EVENT_CHAT_POST_NOT_ALLOWED', mutedUntil: null },
        }),
      );
    });

    it('leaves a muted attendee of a cancelled event refused as read-only', () => {
      const until = new Date('2026-11-26T13:00:00.000Z');
      const access = decideChatAccess(facts({ cancelledAt: NOW, hostMutedAt: MUTED_AT, hostMutedUntil: until }), NOW);

      expect(access).toEqual(
        expect.objectContaining({
          canRead: true,
          post: { allowed: false, refusal: 'EVENT_CHAT_READ_ONLY', mutedUntil: null },
        }),
      );
    });
  });

  describe('no attendance', () => {
    // No row: the user isn't an attendee, a host removed them, or the event
    // or its household is deleted (#992). No role row: a removal deleted it
    // (#551).
    it('refuses when there are no facts', () => {
      expect(decideChatAccess(null, NOW)).toEqual({ canRead: false, refusal: 'EVENT_CHAT_NOT_FOUND' });
    });

    it('refuses an attendee with no event role', () => {
      expect(decideChatAccess(facts({ role: null }), NOW)).toEqual({
        canRead: false,
        refusal: 'EVENT_CHAT_NOT_FOUND',
      });
    });
  });

  describe('an event with no policy row', () => {
    it('lets an attendee who has not answered read and post, as the defaults do', () => {
      expect(decideChatAccess(facts({ status: Invited, policy: null }), NOW)).toEqual({
        canRead: true,
        attendeeId: 'attendee-1',
        moderates: false,
        post: { allowed: true },
      });
    });

    it('refuses a spectator posting, as the defaults do', () => {
      expect(decideChatAccess(facts({ role: SystemRole.EventSpectator, policy: null }), NOW)).toEqual(
        expect.objectContaining({
          canRead: true,
          post: { allowed: false, refusal: 'EVENT_CHAT_POST_NOT_ALLOWED', mutedUntil: null },
        }),
      );
    });
  });
});

describe('chatAccess (#1543)', () => {
  let db: MockDatabaseService;

  const client = () => db as unknown as Prisma.TransactionClient;

  beforeEach(() => {
    db = createMockDatabaseService();
    db.eventAttendee.findFirst.mockResolvedValue(null);
  });

  // An API key, a plugin, the system, a foreign system and an anonymous user
  // are each refused before any read, so the answer says nothing about the
  // event. A plugin acting for a user is refused too: it holds only what was
  // consented to it, never its trigger's attendance. Whether anonymous users
  // join is #488's to decide.
  it.each<[string, Actor]>([
    ['an API key', { kind: 'apiKey', apiKeyId: 'key-1', userId: 'user-1' }],
    [
      'a plugin acting for a user',
      { kind: 'plugin', pluginId: 'plugin-1', unit: SERVER_PLUGIN_UNIT, trigger: { kind: 'user', userId: 'user-1' } },
    ],
    ['the system', { kind: 'system', reason: 'test' }],
    ['a foreign system', { kind: 'external', system: 'gateway', identifier: 'gw-1' }],
    ['an anonymous user', { kind: 'anonymous', userId: 'user-1' }],
  ])('refuses %s without reading anything', async (_name, actor) => {
    await expect(chatAccess(client(), actor, 'event-1', NOW)).resolves.toEqual({
      canRead: false,
      refusal: 'EVENT_CHAT_USER_REQUIRED',
    });
    expect(db.eventAttendee.findFirst).not.toHaveBeenCalled();
  });

  it("decides on the signed-in user's own attendance", async () => {
    db.eventAttendee.findFirst.mockResolvedValue({
      id: 'attendee-7',
      status: Attending,
      role: { role: { name: SystemRole.EventHost } },
      event: { cancelledAt: null, archivedAt: null, policy: null },
      chatState: null,
    } as never);

    const access = await chatAccess(client(), { kind: 'user', userId: 'user-1' }, 'event-1', NOW);

    expect(db.eventAttendee.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ eventId: 'event-1', userId: 'user-1' }) }),
    );
    expect(access).toEqual({ canRead: true, attendeeId: 'attendee-7', moderates: true, post: { allowed: true } });
  });

  it('refuses a signed-in user with no attendance on the event', async () => {
    await expect(chatAccess(client(), { kind: 'user', userId: 'user-1' }, 'event-1', NOW)).resolves.toEqual({
      canRead: false,
      refusal: 'EVENT_CHAT_NOT_FOUND',
    });
  });
});
