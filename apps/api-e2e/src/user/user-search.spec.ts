import { Reach, ResourceType } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { mintApiKey, type Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { userSearchPage } from './user-wire';

/**
 * Which users `GET /api/users/search` answers with, over the real route (#517).
 *
 * The search names its own set: the unbanned users with a searchable profile
 * whose username, first name or display name matches the term, the caller
 * left out. The caller's `User` and `UserProfile` ceilings clip it. Every
 * user's are `read:user:searchable`, which repeats the ban and opt-in clauses,
 * and the profile reads, their own and every `Public` one, so a profile whose
 * reach is narrower is not found (#495). An API key's scope narrows it.
 *
 * The other users are arranged by the test itself: the database is reset
 * before each one, so no user but those below exists to be matched.
 */
describe('user search', () => {
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

  const search = (caller: Caller, q: string) =>
    request(baseUrl).get('/api/users/search').query({ q, limit: 20 }).set(caller.headers);

  const idsOf = (rows: readonly { id: string }[]) => rows.map((row) => row.id).sort();

  /**
   * A caller and six other users whose usernames all carry one term: two who
   * may be found, one banned, one whose profile is not searchable, one whose
   * profile is private, and one the term does not reach because their name
   * lacks it.
   */
  const arrange = async () => {
    const term = `srch${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const named = (suffix: string) => ({ username: `${term}-${suffix}` });

    const [caller, found, alsoFound, banned, unsearchable, unreachable, elsewhere] = await Promise.all([
      actors.user(named('caller')),
      actors.user(named('found')),
      actors.user(named('also-found')),
      actors.user(named('banned')),
      actors.user(named('hidden')),
      actors.user(named('private')),
      actors.user(),
    ]);

    await db.client.user.update({ where: { id: banned.user.id }, data: { banned: true } });
    await db.client.userProfile.update({ where: { userId: unsearchable.user.id }, data: { isSearchable: false } });
    await db.client.userProfile.update({ where: { userId: unreachable.user.id }, data: { reach: Reach.Private } });

    return { term, caller, found, alsoFound, banned, unsearchable, unreachable, elsewhere };
  };

  it('finds the unbanned, searchable users the term matches, and never the caller', async () => {
    const { term, caller, found, alsoFound } = await arrange();

    const page = userSearchPage(await search(caller, term).expect(200), 'GET /api/users/search as a plain user');

    expect(idsOf(page.users)).toEqual(idsOf([found.user, alsoFound.user]));
    expect(page.total).toBe(2);
  });

  // A profile's reach decides who finds it, as it decides who reads it
  // (#495). Searchable and matched, the private profile is left out because
  // the caller cannot read it; `isSearchable` still decides whether a readable
  // profile is offered to search at all.
  it('leaves out a searchable profile whose reach does not admit the caller', async () => {
    const { term, caller, unreachable } = await arrange();

    const page = userSearchPage(await search(caller, term).expect(200), 'GET /api/users/search as a plain user');

    expect(idsOf(page.users)).not.toContain(unreachable.user.id);
    expect(page.total).toBe(2);
  });

  it('serves no column beyond the search columns and the profile name and avatar', async () => {
    const { term, caller } = await arrange();

    const response = await search(caller, term).expect(200);

    for (const user of response.body.users as Record<string, unknown>[]) {
      expect(Object.keys(user).sort()).toEqual(['firstName', 'id', 'image', 'lastName', 'profile', 'username']);
      expect(Object.keys(user['profile'] as object).sort()).toEqual(['avatarUrl', 'displayName']);
    }
  });

  // A guest holds neither type, so this pins the guest's refusal, not either
  // gate on its own. The key cases below pin each gate.
  it('refuses a guest', async () => {
    const guest = await actors.anonymous();

    await search(guest, 'anyone').expect(403);
  });

  describe('through an API key', () => {
    const keyOf = (owner: SessionActor, pins: { userId?: string; profileId?: string } = {}) =>
      mintApiKey(baseUrl, db.client, owner, [
        { slugs: ['read:user:searchable'], resourceType: ResourceType.User, resourceId: pins.userId },
        { slugs: ['read:user:profile:public'], resourceType: ResourceType.UserProfile, resourceId: pins.profileId },
      ]);

    // The control: unpinned, the key finds what its owner finds, so the page
    // below is the pin's narrowing and not a key that finds nothing.
    it('narrows the page to the one user its scope names, and counts only that user', async () => {
      const { term, caller, found, alsoFound } = await arrange();

      const unpinned = userSearchPage(
        await search(await keyOf(caller), term).expect(200),
        'GET /api/users/search with an unpinned key',
      );
      expect(idsOf(unpinned.users)).toEqual(idsOf([found.user, alsoFound.user]));

      const pinned = userSearchPage(
        await search(await keyOf(caller, { userId: found.user.id }), term).expect(200),
        'GET /api/users/search with a key pinned to one user',
      );
      expect(idsOf(pinned.users)).toEqual([found.user.id]);
      expect(pinned.total).toBe(1);
    });

    // Each row carries its profile's name and avatar, so the key's profile
    // scope clips the rows as its user scope does. Without it, a key pinned to
    // one profile was served every matched user's.
    it('narrows the page to the one profile its scope names', async () => {
      const { term, caller, found } = await arrange();
      const profile = await db.client.userProfile.findUniqueOrThrow({
        where: { userId: found.user.id },
        select: { id: true },
      });

      const pinned = userSearchPage(
        await search(await keyOf(caller, { profileId: profile.id }), term).expect(200),
        'GET /api/users/search with a key pinned to one profile',
      );
      expect(idsOf(pinned.users)).toEqual([found.user.id]);
      expect(pinned.total).toBe(1);
    });

    // The rows are users and each carries its profile's columns, so a key
    // must read both. One that reads only one of them would otherwise get an
    // empty page rather than a refusal.
    it('refuses a key that reads profiles but not users', async () => {
      const { term, caller } = await arrange();
      const key = await mintApiKey(baseUrl, db.client, caller, {
        slugs: ['read:user:profile:public'],
        resourceType: ResourceType.UserProfile,
      });

      await search(key, term).expect(403);
    });

    it('refuses a key that reads users but not their profiles', async () => {
      const { term, caller } = await arrange();
      const key = await mintApiKey(baseUrl, db.client, caller, {
        slugs: ['read:user:searchable'],
        resourceType: ResourceType.User,
      });

      await search(key, term).expect(403);
    });
  });
});
