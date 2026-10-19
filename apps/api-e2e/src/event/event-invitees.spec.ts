import { FriendshipStatus, Reach } from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor, type SessionActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { createEventClient, EVENTS_PATH } from './event-request';

/** The server policy's refusal. */
const FRIENDS_ONLY = 'This server only allows you to place your friends on an event';

/** A block's or a preference's refusal: one message, so the caller cannot tell which. */
const REFUSED = 'You cannot place this user on an event';

/**
 * Whom a user may place on an event by id (#546), on both ways of doing it:
 * the create's `inviteUserIds`, and the direct add.
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
describe('placing a user on an event', () => {
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

  const addAttendee = (actor: AuthenticatedActor, eventId: string, userId: string) =>
    request(baseUrl).post(`${EVENTS_PATH}/${eventId}/attendees`).set(actor.headers).send({ userId });

  const eventsCreatedBy = (actor: SessionActor) => db.client.event.count({ where: { createdById: actor.user.id } });

  const attendeeCount = (eventId: string) => db.client.eventAttendee.count({ where: { eventId } });

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
    it('answers 404 on the create, where it answered 500, and writes no event', async () => {
      const host = await actors.user();
      const invitee = await actors.user();

      // Control: the same create, inviting a person.
      await createEvent(host, { inviteUserIds: [invitee.user.id] }).expect(201);
      const before = await eventsCreatedBy(host);

      await createEvent(host, { inviteUserIds: [invitee.user.id, randomUUID()] }).expect(404);
      for (const id of await nonPersonIds()) {
        await createEvent(host, { inviteUserIds: [id] }).expect(404);
      }
      expect(await eventsCreatedBy(host)).toBe(before);
    });

    it('answers 404 on the direct add, where it answered 500, and adds no one', async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host);
      const before = await attendeeCount(eventId);

      await addAttendee(host, eventId, randomUUID()).expect(404);
      for (const id of await nonPersonIds()) {
        await addAttendee(host, eventId, id).expect(404);
      }
      expect(await attendeeCount(eventId)).toBe(before);
    });
  });

  describe("the invitee's settings", () => {
    it('refuses a blocked pair on both paths, whichever of the two blocked, and writes nothing', async () => {
      const [host, blocker, blocked] = await Promise.all([actors.user(), actors.user(), actors.user()]);
      await block(blocker, host);
      await block(host, blocked);
      const eventId = await createdEventId(host);
      const before = { events: await eventsCreatedBy(host), attendees: await attendeeCount(eventId) };

      for (const refused of [blocker, blocked]) {
        expect((await createEvent(host, { inviteUserIds: [refused.user.id] }).expect(403)).body.message).toBe(REFUSED);
        expect((await addAttendee(host, eventId, refused.user.id).expect(403)).body.message).toBe(REFUSED);
      }

      expect(await eventsCreatedBy(host)).toBe(before.events);
      expect(await attendeeCount(eventId)).toBe(before.attendees);
    });

    it('refuses a user whose event preference is Private on both paths, and ignores their household one', async () => {
      const [host, closed, householdOnly] = await Promise.all([actors.user(), actors.user(), actors.user()]);
      await prefer(closed, { allowEventInvitesFrom: Reach.Private });
      await prefer(householdOnly, { allowHouseholdInvitesFrom: Reach.Private });
      const eventId = await createdEventId(host);

      expect((await createEvent(host, { inviteUserIds: [closed.user.id] }).expect(403)).body.message).toBe(REFUSED);
      expect((await addAttendee(host, eventId, closed.user.id).expect(403)).body.message).toBe(REFUSED);

      await createEvent(host, { inviteUserIds: [householdOnly.user.id] }).expect(201);
      await addAttendee(host, eventId, householdOnly.user.id).expect(201);
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
      expect((await addAttendee(host, eventId, stranger.user.id).expect(403)).body.message).toBe(FRIENDS_ONLY);

      await createEvent(host, { inviteUserIds: [friend.user.id] }).expect(201);
      await addAttendee(host, eventId, friend.user.id).expect(201);
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
