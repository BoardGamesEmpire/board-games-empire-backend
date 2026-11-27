import type { Prisma } from '@bge/database';
import { EventChatAccess, EventParticipationStatus, liveEventWhere, SystemRole } from '@bge/database';
import type { MockDatabaseService } from '@bge/testing';
import { createMockDatabaseService } from '@bge/testing';
import { loadChatFacts } from './chat-facts';

const CANCELLED_AT = new Date('2026-11-20T09:00:00.000Z');
const MUTED_AT = new Date('2026-11-26T10:00:00.000Z');
const MUTED_UNTIL = new Date('2026-11-26T13:00:00.000Z');

const POLICY = {
  chatEnabled: false,
  chatReadAccess: EventChatAccess.Responded,
  chatPostAccess: EventChatAccess.Attending,
  chatSpectatorsMayPost: true,
};

/** The attendee row the loader reads, as its select shapes it. */
const row = (overrides: object = {}) => ({
  id: 'attendee-1',
  status: EventParticipationStatus.Maybe,
  role: {
    role: {
      name: SystemRole.EventCoHost,
      permissions: [
        { permission: { slug: 'read:event_chat_message' } },
        { permission: { slug: 'delete:event_chat_message' } },
      ],
    },
  },
  event: { cancelledAt: CANCELLED_AT, archivedAt: null, policy: POLICY },
  chatState: { hostMutedAt: MUTED_AT, hostMutedUntil: MUTED_UNTIL },
  ...overrides,
});

describe('loadChatFacts (#1543)', () => {
  let db: MockDatabaseService;

  const client = () => db as unknown as Prisma.TransactionClient;

  /** The `where` the loader's one read was given. */
  const readWhere = () => db.eventAttendee.findFirst.mock.calls[0][0]?.where;

  beforeEach(() => {
    db = createMockDatabaseService();
    db.eventAttendee.findFirst.mockResolvedValue(row() as never);
  });

  it("reads the user's attendee row on the event, unless a host removed them, while the event is live", async () => {
    await loadChatFacts(client(), 'user-1', 'event-1');

    expect(db.eventAttendee.findFirst).toHaveBeenCalledTimes(1);
    expect(readWhere()).toEqual({
      eventId: 'event-1',
      userId: 'user-1',
      removedAt: null,
      event: { is: liveEventWhere() },
    });
  });

  // The where is the only guard: the client applies no ability to a read.
  it('finds nothing on a soft-deleted event, its host included (#992)', async () => {
    await loadChatFacts(client(), 'user-1', 'event-1');

    expect(readWhere()?.event).toEqual({ is: expect.objectContaining({ deletedAt: null }) });
  });

  it('finds nothing on an event in a soft-deleted household, and still finds one outside any household (#992)', async () => {
    await loadChatFacts(client(), 'user-1', 'event-1');

    expect(readWhere()?.event).toEqual({
      is: expect.objectContaining({ OR: [{ householdId: null }, { household: { is: { deletedAt: null } } }] }),
    });
  });

  it("selects the role's name and chat grants, the event's state, the event policy's chat controls, and the attendee's host mute", async () => {
    await loadChatFacts(client(), 'user-1', 'event-1');

    expect(db.eventAttendee.findFirst.mock.calls[0][0]?.select).toEqual({
      id: true,
      status: true,
      role: {
        select: {
          role: {
            select: {
              name: true,
              permissions: {
                where: {
                  revokedAt: null,
                  permission: {
                    is: {
                      slug: {
                        in: ['read:event_chat_message', 'create:event_chat_message', 'delete:event_chat_message'],
                      },
                      retiredAt: null,
                      inverted: false,
                    },
                  },
                },
                select: { permission: { select: { slug: true } } },
              },
            },
          },
        },
      },
      event: {
        select: {
          cancelledAt: true,
          archivedAt: true,
          policy: {
            select: { chatEnabled: true, chatReadAccess: true, chatPostAccess: true, chatSpectatorsMayPost: true },
          },
        },
      },
      chatState: { select: { hostMutedAt: true, hostMutedUntil: true } },
    });
  });

  it('gives the facts the row holds', async () => {
    await expect(loadChatFacts(client(), 'user-1', 'event-1')).resolves.toEqual({
      attendeeId: 'attendee-1',
      status: EventParticipationStatus.Maybe,
      role: SystemRole.EventCoHost,
      grants: { read: true, post: false, moderate: true },
      cancelledAt: CANCELLED_AT,
      archivedAt: null,
      policy: POLICY,
      hostMutedAt: MUTED_AT,
      hostMutedUntil: MUTED_UNTIL,
    });
  });

  it('gives no host mute for an attendee with no chat state row', async () => {
    db.eventAttendee.findFirst.mockResolvedValue(row({ chatState: null }) as never);

    await expect(loadChatFacts(client(), 'user-1', 'event-1')).resolves.toEqual(
      expect.objectContaining({ hostMutedAt: null, hostMutedUntil: null }),
    );
  });

  it('gives a null role and no grants for an attendee with no role row (#551)', async () => {
    db.eventAttendee.findFirst.mockResolvedValue(row({ role: null }) as never);

    await expect(loadChatFacts(client(), 'user-1', 'event-1')).resolves.toEqual(
      expect.objectContaining({ role: null, grants: { read: false, post: false, moderate: false } }),
    );
  });

  // The where leaves out a revoked grant, a retired permission and an
  // inverted one, so a role the Owner took the read from holds none (#772).
  it('gives no grants for a role whose chat grants the read leaves out', async () => {
    db.eventAttendee.findFirst.mockResolvedValue(
      row({ role: { role: { name: SystemRole.EventSpectator, permissions: [] } } }) as never,
    );

    await expect(loadChatFacts(client(), 'user-1', 'event-1')).resolves.toEqual(
      expect.objectContaining({ grants: { read: false, post: false, moderate: false } }),
    );
  });

  it('gives a null policy for an event with no policy row', async () => {
    db.eventAttendee.findFirst.mockResolvedValue(
      row({ event: { cancelledAt: null, archivedAt: null, policy: null } }) as never,
    );

    await expect(loadChatFacts(client(), 'user-1', 'event-1')).resolves.toEqual(
      expect.objectContaining({ policy: null }),
    );
  });

  it('gives null when there is no such row', async () => {
    db.eventAttendee.findFirst.mockResolvedValue(null);

    await expect(loadChatFacts(client(), 'user-1', 'event-1')).resolves.toBeNull();
  });
});
