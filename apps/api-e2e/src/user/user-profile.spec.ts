import { FriendshipStatus, Reach } from '@bge/database';
import { arrangeFriendship, befriend, createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { userProfile, userSearchPage } from './user-wire';

/** Served to the profile's owner alone, staff included (#819). */
const OWNER_ONLY = ['dietaryRestrictions', 'accessibilityNeeds', 'reach', 'isSearchable'];

/**
 * Who reads a profile over `GET /api/users/:id/profile` and
 * `GET /api/users/me/profile`, and how its owner edits it over
 * `PATCH /api/users/me/profile` (#819).
 *
 * A profile is read under its reach: by its owner, by their accepted friends
 * when it reaches friends, and by every signed-in user when it is `Public`.
 * Staff read every profile. Anything else answers 404, as a missing profile
 * does. The owner-only fields go to the profile's owner alone. A user reading
 * by reach gets 404 for a banned user's profile, and staff still read it
 * (#840).
 */
describe('user profile', () => {
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

  const readProfile = (caller: AuthenticatedActor, userId: string) =>
    request(baseUrl).get(`/api/users/${userId}/profile`).set(caller.headers);

  const readOwnProfile = (caller: AuthenticatedActor) =>
    request(baseUrl).get('/api/users/me/profile').set(caller.headers);

  /** A user whose profile has the given reach and holds every owner-only field, a friend of theirs, and a stranger. */
  const arrange = async (reach: Reach) => {
    const [profileOwner, friend, stranger] = await Promise.all([actors.user(), actors.user(), actors.user()]);
    await db.client.userProfile.update({
      where: { userId: profileOwner.user.id },
      data: { reach, dietaryRestrictions: 'No nuts', accessibilityNeeds: 'Step-free access' },
    });
    await befriend(db.client, friend, profileOwner);

    return { profileOwner, friend, stranger };
  };

  /** Bans the user, writing the columns directly, as the API key spec does. */
  const ban = (actor: AuthenticatedActor, data: { banExpires?: Date } = {}) =>
    db.client.user.update({ where: { id: actor.user.id }, data: { banned: true, ...data } });

  it('lets a friend read a Friends profile, and answers a stranger 404', async () => {
    const { profileOwner, friend, stranger } = await arrange(Reach.Friends);

    const asFriend = userProfile(
      await readProfile(friend, profileOwner.user.id).expect(200),
      'GET /api/users/:id/profile as a friend',
    );
    expect(asFriend.userId).toBe(profileOwner.user.id);
    expect(asFriend.username).toBe(profileOwner.user.username);
    for (const field of OWNER_ONLY) {
      expect(asFriend).not.toHaveProperty(field);
    }

    await readProfile(stranger, profileOwner.user.id).expect(404);
  });

  // Searchable decides whether a profile is offered to search, not who may
  // read it.
  it('lets anyone signed in read a Public profile, even one that is not searchable', async () => {
    const { profileOwner, stranger } = await arrange(Reach.Public);
    await db.client.userProfile.update({ where: { userId: profileOwner.user.id }, data: { isSearchable: false } });

    const asStranger = userProfile(
      await readProfile(stranger, profileOwner.user.id).expect(200),
      'GET /api/users/:id/profile as a stranger',
    );
    expect(asStranger.userId).toBe(profileOwner.user.id);
  });

  it('answers a friend 404 for a Private profile', async () => {
    const { profileOwner, friend } = await arrange(Reach.Private);

    await readProfile(friend, profileOwner.user.id).expect(404);
  });

  // Which friendships admit a friend (#294). The accepted friend reads the
  // same profile first, so the 404 is the friendship's state, not the
  // profile's.
  it.each([
    ['a pending request from the viewer', FriendshipStatus.Pending, 'viewer'],
    ["a pending request from the profile's owner", FriendshipStatus.Pending, 'profileOwner'],
    ['a block by the viewer', FriendshipStatus.Blocked, 'viewer'],
    ["a block by the profile's owner", FriendshipStatus.Blocked, 'profileOwner'],
  ] as const)('answers 404 for a Friends profile over %s', async (_case, status, requester) => {
    const { profileOwner, friend, stranger: viewer } = await arrange(Reach.Friends);
    const [from, to] = requester === 'viewer' ? [viewer, profileOwner] : [profileOwner, viewer];
    await arrangeFriendship(db.client, from, to, status);

    await readProfile(friend, profileOwner.user.id).expect(200);
    await readProfile(viewer, profileOwner.user.id).expect(404);
  });

  // A banned user's profile is hidden from other users as user search hides
  // them (#840). The reader gets the profile before the ban, so the 404 is
  // the ban's, not the reach's.
  it.each([
    [Reach.Public, 'a stranger', 'stranger'],
    [Reach.Friends, 'a friend', 'friend'],
    [Reach.FriendsOfFriends, 'a friend of a friend', 'friendOfFriend'],
  ] as const)(
    'answers 404 for a banned user’s %s profile to %s who read it before the ban (#840)',
    async (reach, _reader, readerKey) => {
      const { profileOwner, friend, stranger } = await arrange(reach);
      let reader = readerKey === 'friend' ? friend : stranger;
      if (readerKey === 'friendOfFriend') {
        reader = await actors.user();
        await befriend(db.client, reader, friend);
      }

      await readProfile(reader, profileOwner.user.id).expect(200);
      await ban(profileOwner);

      await readProfile(reader, profileOwner.user.id).expect(404);
    },
  );

  // better-auth lifts an expired ban only at the user's next sign-in, and user
  // search waits for that too, so the profile stays hidden until then (#840).
  it('still answers 404 for a ban that has lapsed but not been lifted (#840)', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const { profileOwner, stranger } = await arrange(Reach.Public);
    await readProfile(stranger, profileOwner.user.id).expect(200);

    await ban(profileOwner, { banExpires: new Date(Date.now() - DAY_MS) });

    await readProfile(stranger, profileOwner.user.id).expect(404);
  });

  // The read conditions are evaluated in the database on every request, not
  // cached per user, so lifting the ban shows the profile at once (#840).
  it('serves the profile again once the ban is lifted (#840)', async () => {
    const { profileOwner, stranger } = await arrange(Reach.Public);
    await ban(profileOwner);
    await readProfile(stranger, profileOwner.user.id).expect(404);

    await db.client.user.update({ where: { id: profileOwner.user.id }, data: { banned: false, banExpires: null } });

    await readProfile(stranger, profileOwner.user.id).expect(200);
  });

  it('serves staff a banned user’s profile, without its owner-only fields (#840)', async () => {
    const [{ profileOwner }, admin] = await Promise.all([arrange(Reach.Public), actors.admin()]);
    await ban(profileOwner);

    const asAdmin = userProfile(
      await readProfile(admin, profileOwner.user.id).expect(200),
      'GET /api/users/:id/profile of a banned user as staff',
    );
    expect(asAdmin.userId).toBe(profileOwner.user.id);
    for (const field of OWNER_ONLY) {
      expect(asAdmin).not.toHaveProperty(field);
    }
  });

  // `me/profile` is declared before `:id/profile`, so "me" is never read as a
  // user id.
  it('serves a user their own profile at /me/profile and at their own id, health details included', async () => {
    const { profileOwner } = await arrange(Reach.Private);

    const atMe = userProfile(await readOwnProfile(profileOwner).expect(200), 'GET /api/users/me/profile');
    const atId = userProfile(
      await readProfile(profileOwner, profileOwner.user.id).expect(200),
      "GET /api/users/:id/profile as the profile's owner",
    );

    expect(atMe.userId).toBe(profileOwner.user.id);
    expect(atId).toEqual(atMe);
    expect(atMe).toMatchObject({
      dietaryRestrictions: 'No nuts',
      accessibilityNeeds: 'Step-free access',
      reach: Reach.Private,
      isSearchable: true,
    });
  });

  it("serves staff a Private profile without its owner's health details, reach or searchable", async () => {
    const [{ profileOwner }, admin] = await Promise.all([arrange(Reach.Private), actors.admin()]);

    const asAdmin = userProfile(
      await readProfile(admin, profileOwner.user.id).expect(200),
      'GET /api/users/:id/profile as staff',
    );
    expect(asAdmin.userId).toBe(profileOwner.user.id);
    for (const field of OWNER_ONLY) {
      expect(asAdmin).not.toHaveProperty(field);
    }
  });

  // Email sign-up takes `image` from the request body, so it is a URL the
  // registrant chose, not a provider's picture. As an avatar, every client
  // showing it would fetch it from the registrant's server (#695, #829).
  it('gives an email sign-up no avatar, whatever picture it sent', async () => {
    const profileOwner = await actors.user({ image: 'https://tracker.example/pixel.png' });

    const own = userProfile(await readOwnProfile(profileOwner).expect(200), 'GET /api/users/me/profile');
    expect(own['avatarUrl']).toBeNull();

    const row = await db.client.user.findUniqueOrThrow({
      where: { id: profileOwner.user.id },
      select: { image: true },
    });
    expect(row.image).toBeNull();
  });

  it('answers 404 for a user id that does not exist', async () => {
    const caller = await actors.user();

    await readProfile(caller, 'no-such-user').expect(404);
  });

  // An anonymous user holds no profile read, so the type-level check refuses
  // it before any lookup.
  it('refuses an anonymous user', async () => {
    const [{ profileOwner }, anonymous] = await Promise.all([arrange(Reach.Public), actors.anonymous()]);

    await readProfile(anonymous, profileOwner.user.id).expect(403);
    await readOwnProfile(anonymous).expect(403);
  });

  describe('the edit', () => {
    const editOwnProfile = (caller: AuthenticatedActor, body: Record<string, unknown>) =>
      request(baseUrl).patch('/api/users/me/profile').set(caller.headers).send(body);

    const search = (caller: AuthenticatedActor, q: string) =>
      request(baseUrl).get('/api/users/search').query({ q, limit: 20 }).set(caller.headers);

    it("lets the profile's owner narrow reach and turn searchable off, and the stranger loses the profile and the search hit", async () => {
      const term = `prof${randomUUID().replaceAll('-', '').slice(0, 8)}`;
      const [profileOwner, stranger] = await Promise.all([
        actors.user({ username: `${term}-profile` }),
        actors.user({ username: `${term}-stranger` }),
      ]);

      // Control: before the edit, the stranger reads and finds the profile.
      await readProfile(stranger, profileOwner.user.id).expect(200);
      const before = userSearchPage(await search(stranger, term).expect(200), 'GET /api/users/search before');
      expect(before.users.map((user) => user.id)).toContain(profileOwner.user.id);

      const edited = userProfile(
        await editOwnProfile(profileOwner, { reach: Reach.Private, isSearchable: false }).expect(200),
        'PATCH /api/users/me/profile',
      );
      expect(edited).toMatchObject({ userId: profileOwner.user.id, reach: Reach.Private, isSearchable: false });

      await readProfile(stranger, profileOwner.user.id).expect(404);
      const after = userSearchPage(await search(stranger, term).expect(200), 'GET /api/users/search after');
      expect(after.users.map((user) => user.id)).not.toContain(profileOwner.user.id);
    });

    it('lets a friend read the profile once its owner sets it to Friends', async () => {
      const { profileOwner, friend, stranger } = await arrange(Reach.Private);
      await readProfile(friend, profileOwner.user.id).expect(404);

      await editOwnProfile(profileOwner, { reach: Reach.Friends }).expect(200);

      await readProfile(friend, profileOwner.user.id).expect(200);
      await readProfile(stranger, profileOwner.user.id).expect(404);
    });

    it('lets a friend of a friend read the profile once its owner sets it to FriendsOfFriends (#496)', async () => {
      const { profileOwner, friend, stranger } = await arrange(Reach.Private);
      const friendOfFriend = await actors.user();
      await befriend(db.client, friendOfFriend, friend);
      await readProfile(friendOfFriend, profileOwner.user.id).expect(404);

      const edited = userProfile(
        await editOwnProfile(profileOwner, { reach: Reach.FriendsOfFriends }).expect(200),
        'PATCH /api/users/me/profile',
      );
      expect(edited).toMatchObject({ reach: Reach.FriendsOfFriends });

      await readProfile(friendOfFriend, profileOwner.user.id).expect(200);
      await readProfile(friend, profileOwner.user.id).expect(200);
      await readProfile(stranger, profileOwner.user.id).expect(404);
    });

    it('refuses an avatar change for now', async () => {
      const profileOwner = await actors.user();

      await editOwnProfile(profileOwner, { avatarUrl: 'https://x.example/a.png' }).expect(400);
    });

    it('refuses an empty edit', async () => {
      const profileOwner = await actors.user();

      await editOwnProfile(profileOwner, {}).expect(400);
    });

    // The column keeps a value, so null is a 400 from validation and never
    // reaches the database.
    it('refuses null for a field whose column keeps a value', async () => {
      const profileOwner = await actors.user();

      await editOwnProfile(profileOwner, { isSearchable: null }).expect(400);
    });

    // The global pipe converts implicitly, and Boolean('false') is true (#819).
    it('refuses searchable sent as the string "false" and leaves the profile searchable', async () => {
      const profileOwner = await actors.user();

      await editOwnProfile(profileOwner, { isSearchable: 'false' }).expect(400);

      const read = userProfile(await readOwnProfile(profileOwner).expect(200), 'GET /api/users/me/profile');
      expect(read.isSearchable).toBe(true);
    });

    it('clears a text field sent blank', async () => {
      const profileOwner = await actors.user();
      await editOwnProfile(profileOwner, { pronouns: 'they/them' }).expect(200);

      const cleared = userProfile(
        await editOwnProfile(profileOwner, { pronouns: '   ' }).expect(200),
        'PATCH /api/users/me/profile with blank pronouns',
      );
      expect(cleared['pronouns']).toBeNull();
    });

    it('stores the bio sanitized and serves it back', async () => {
      const profileOwner = await actors.user();

      const edited = userProfile(
        await editOwnProfile(profileOwner, { bio: '<script>alert(1)</script>\n\n**Engines** and games' }).expect(200),
        'PATCH /api/users/me/profile with a bio',
      );
      expect(edited['bio']).toBe('**Engines** and games');

      const read = userProfile(await readOwnProfile(profileOwner).expect(200), 'GET /api/users/me/profile');
      expect(read['bio']).toBe('**Engines** and games');
    });

    // An anonymous user holds no profile update, so the type-level check
    // refuses it.
    it('refuses an anonymous user', async () => {
      const anonymous = await actors.anonymous();

      await editOwnProfile(anonymous, { location: 'London' }).expect(403);
    });
  });
});
