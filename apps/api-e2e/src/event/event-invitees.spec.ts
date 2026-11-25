import { FriendshipStatus, InviteStatus, Reach, SystemRole } from '@bge/database';
import type { Actors, AuthenticatedActor, SessionActor } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import { createEventInviteClient } from './event-join';
import { createEventClient, EVENTS_PATH } from './event-request';
import { eventDetailEnvelope, eventReplayEnvelope } from './event-wire';

/** The server policy's refusal. */
const FRIENDS_ONLY = 'This server only lets you invite your friends to an event.';

/** A block's or a preference's refusal: one message, so the caller cannot tell which. */
const REFUSED = "You can't invite this person to this event.";

/**
 * Whom a user may invite to an event by id (#546), on both ways of doing it:
 * the create's `inviteUserIds`, and the event's invite route. Both send an
 * invite, and the invitee becomes an attendee only by accepting it (#742).
 * The direct add places only people without an account, and refuses an id.
 *
 * The id has to name a person, or the answer is 404, where an unknown id
 * answered 500. Then the checks a household invite makes (#278), on the
 * event's own settings: the server's `eventInviteePolicy`, a block between
 * the two, and the user's `allowEventInvitesFrom`. Each refusal is 403, and
 * nothing is written.
 *
 * The settings row is on the isolation sweep's preserved list, so each test
 * puts the policy back.
 */
describe('inviting a user to an event (#546, #742)', () => {
  const baseUrl = requireBaseUrl(process.env);

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const readPolicy = async () =>
    (await db.client.systemSetting.findUniqueOrThrow({ where: { singleton: true } })).eventInviteePolicy;

  const setPolicy = (eventInviteePolicy: Reach) =>
    db.client.systemSetting.update({ where: { singleton: true }, data: { eventInviteePolicy } });

  let originalPolicy: Reach;

  beforeEach(async () => {
    originalPolicy = await readPolicy();
  });

  afterEach(async () => {
    await setPolicy(originalPolicy);
  });

  const { createEvent, createdEventId } = createEventClient(baseUrl);

  const { invite } = createEventInviteClient(baseUrl);

  const addAttendee = (actor: AuthenticatedActor, eventId: string, body: Record<string, unknown>) =>
    request(baseUrl).post(`${EVENTS_PATH}/${eventId}/attendees`).set(actor.headers).send(body);

  const eventsCreatedBy = (actor: SessionActor) => db.client.event.count({ where: { createdById: actor.user.id } });

  const attendeeCount = (eventId: string) => db.client.eventAttendee.count({ where: { eventId } });

  const inviteCount = (eventId: string) => db.client.invite.count({ where: { eventId } });

  /** Invites sent by `inviter`, on whatever event: a refused create leaves none behind. */
  const invitesSentBy = (inviter: SessionActor) => db.client.invite.count({ where: { inviterId: inviter.user.id } });

  /** A block, written as the friendship service leaves one: the blocker is the row's requester. */
  const block = (blocker: SessionActor, blocked: SessionActor) =>
    db.client.friendship.create({
      data: {
        requesterId: blocker.user.id,
        addresseeId: blocked.user.id,
        pairKey: [blocker.user.id, blocked.user.id].sort().join(':'),
        status: FriendshipStatus.Blocked,
        respondedAt: new Date(),
      },
    });

  const befriend = (a: SessionActor, b: SessionActor) =>
    db.client.friendship.create({
      data: {
        requesterId: a.user.id,
        addresseeId: b.user.id,
        pairKey: [a.user.id, b.user.id].sort().join(':'),
        status: FriendshipStatus.Accepted,
        respondedAt: new Date(),
      },
    });

  /** No route writes a preference yet (#725), so it is written here. */
  const prefer = (
    actor: SessionActor,
    preferences: { allowEventInvitesFrom?: Reach; allowHouseholdInvitesFrom?: Reach },
  ) =>
    db.client.userPreferences.upsert({
      where: { userId: actor.user.id },
      create: { userId: actor.user.id, ...preferences },
      update: preferences,
    });

  /**
   * Accounts that are no person, as `household-invites.spec.ts` arranges
   * them: one shaped like the server's service account, and an anonymous
   * user's.
   */
  const nonPersonIds = async () => {
    const ids: string[] = [];
    for (const shape of [{ isServiceAccount: true, banned: true }, { isAnonymous: true }]) {
      const tag = randomUUID();
      const account = await db.client.user.create({
        data: { username: `nonperson-${tag}`, email: `nonperson-${tag}@e2e.invalid`, emailVerified: true, ...shape },
        select: { id: true },
      });
      ids.push(account.id);
    }

    return ids;
  };

  describe('an id that names no person', () => {
    it('answers 404 on the create, where it answered 500, and writes no event or invite (#742)', async () => {
      const host = await actors.user();
      const invitee = await actors.user();

      // Control: the same create, inviting a person.
      await createEvent(host, { inviteUserIds: [invitee.user.id] }).expect(201);
      const before = { events: await eventsCreatedBy(host), invites: await invitesSentBy(host) };

      await createEvent(host, { inviteUserIds: [invitee.user.id, randomUUID()] }).expect(404);
      for (const id of await nonPersonIds()) {
        await createEvent(host, { inviteUserIds: [id] }).expect(404);
      }

      expect(await eventsCreatedBy(host)).toBe(before.events);
      expect(await invitesSentBy(host)).toBe(before.invites);
    });

    it('answers 404 on the invite route, and sends no invite (#742)', async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host);

      await invite(host, eventId, { userId: randomUUID() }).expect(404);
      for (const id of await nonPersonIds()) {
        await invite(host, eventId, { userId: id }).expect(404);
      }

      expect(await inviteCount(eventId)).toBe(0);
    });
  });

  // The create's `inviteUserIds` sends invites, as the invite route does: an
  // invitee holds no event role and has no attendee row until they accept,
  // so they read the event but not who attends it (#742).
  it("the create's invitees have no attendee row and no role (#742)", async () => {
    const [host, first, second] = await Promise.all([actors.user(), actors.user(), actors.user()]);

    // A create answers in the shape its replay does.
    const created = eventReplayEnvelope(
      await createEvent(host, { inviteUserIds: [first.user.id, second.user.id, host.user.id] }).expect(201),
      'POST /api/events',
    );

    // The host is the create's one attendee, and the create answers with them alone.
    expect(
      await db.client.eventAttendee.findMany({ where: { eventId: created.id }, select: { userId: true } }),
    ).toEqual([{ userId: host.user.id }]);
    expect(created.attendees.map(({ userId }) => userId)).toEqual([host.user.id]);

    // Each invitee holds an invite from the host, offering the participant
    // role, and the creator is invited to nothing.
    const invites = await db.client.invite.findMany({
      where: { eventId: created.id },
      select: { inviteeId: true, inviterId: true, status: true, role: { select: { name: true } } },
    });
    expect(invites.map(({ inviteeId }) => inviteeId).sort()).toEqual([first.user.id, second.user.id].sort());
    for (const row of invites) {
      expect(row).toEqual(
        expect.objectContaining({
          inviterId: host.user.id,
          status: InviteStatus.Pending,
          role: { name: SystemRole.EventParticipant },
        }),
      );
    }

    // No role: an invitee reads the event through their open invite, with no
    // attendee in it and no attendance of their own.
    const read = eventDetailEnvelope(
      await request(baseUrl).get(`${EVENTS_PATH}/${created.id}`).set(first.headers).expect(200),
      'GET /api/events/:id as an invitee',
    );
    expect(read.attendees).toEqual([]);
    expect(read.attendance).toBeNull();
  });

  // Everyone with an account is invited instead (#742).
  it('refuses a userId on the direct add with 400 ATTENDEE_ACCOUNT_NEEDS_INVITE, and adds no one (#742)', async () => {
    const [host, user] = await Promise.all([actors.user(), actors.user()]);
    const eventId = await createdEventId(host);
    const before = await attendeeCount(eventId);

    expectErrorEnvelope(await addAttendee(host, eventId, { userId: user.user.id }), {
      status: 400,
      code: 'ATTENDEE_ACCOUNT_NEEDS_INVITE',
    });
    expectErrorEnvelope(await addAttendee(host, eventId, { userId: user.user.id, guestName: 'Pat' }), {
      status: 400,
      code: 'ATTENDEE_ACCOUNT_NEEDS_INVITE',
    });

    expect(await attendeeCount(eventId)).toBe(before);
    expect(await inviteCount(eventId)).toBe(0);
  });

  describe("the invitee's settings", () => {
    it('refuses a blocked pair on both paths, whichever of the two blocked, and writes nothing', async () => {
      const [host, blocker, blocked] = await Promise.all([actors.user(), actors.user(), actors.user()]);
      await block(blocker, host);
      await block(host, blocked);
      const eventId = await createdEventId(host);
      const before = { events: await eventsCreatedBy(host), invites: await invitesSentBy(host) };

      for (const refused of [blocker, blocked]) {
        expect((await createEvent(host, { inviteUserIds: [refused.user.id] }).expect(403)).body.message).toBe(REFUSED);
        expect((await invite(host, eventId, { userId: refused.user.id }).expect(403)).body.message).toBe(REFUSED);
      }

      expect(await eventsCreatedBy(host)).toBe(before.events);
      expect(await invitesSentBy(host)).toBe(before.invites);
    });

    it('refuses a user whose event preference is Private on both paths, and ignores their household one', async () => {
      const [host, closed, householdOnly] = await Promise.all([actors.user(), actors.user(), actors.user()]);
      await prefer(closed, { allowEventInvitesFrom: Reach.Private });
      await prefer(householdOnly, { allowHouseholdInvitesFrom: Reach.Private });
      const eventId = await createdEventId(host);

      expect((await createEvent(host, { inviteUserIds: [closed.user.id] }).expect(403)).body.message).toBe(REFUSED);
      expect((await invite(host, eventId, { userId: closed.user.id }).expect(403)).body.message).toBe(REFUSED);

      await createEvent(host, { inviteUserIds: [householdOnly.user.id] }).expect(201);
      await invite(host, eventId, { userId: householdOnly.user.id }).expect(201);
    });
  });

  describe("the server's policy", () => {
    it('lets only friends in under Friends, on both paths', async () => {
      const [host, friend, stranger] = await Promise.all([actors.user(), actors.user(), actors.user()]);
      await befriend(host, friend);
      const eventId = await createdEventId(host);
      await setPolicy(Reach.Friends);

      expect((await createEvent(host, { inviteUserIds: [stranger.user.id] }).expect(403)).body.message).toBe(
        FRIENDS_ONLY,
      );
      expect((await invite(host, eventId, { userId: stranger.user.id }).expect(403)).body.message).toBe(FRIENDS_ONLY);

      await createEvent(host, { inviteUserIds: [friend.user.id] }).expect(201);
      await invite(host, eventId, { userId: friend.user.id }).expect(201);
    });

    it("is the event's own: the household policy at Friends refuses no one here", async () => {
      const [host, stranger] = await Promise.all([actors.user(), actors.user()]);
      const original = (await db.client.systemSetting.findUniqueOrThrow({ where: { singleton: true } }))
        .householdInviteePolicy;
      await db.client.systemSetting.update({
        where: { singleton: true },
        data: { householdInviteePolicy: Reach.Friends },
      });

      try {
        await createEvent(host, { inviteUserIds: [stranger.user.id] }).expect(201);
      } finally {
        await db.client.systemSetting.update({
          where: { singleton: true },
          data: { householdInviteePolicy: original },
        });
      }
    });
  });

  it('answers 400 to more invitees than one create may name, and writes nothing', async () => {
    const host = await actors.user();
    const before = await eventsCreatedBy(host);

    await createEvent(host, { inviteUserIds: Array.from({ length: 51 }, () => randomUUID()) }).expect(400);
    expect(await eventsCreatedBy(host)).toBe(before);
  });
});
