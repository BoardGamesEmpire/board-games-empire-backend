import { SystemRole } from '@bge/database';
import { PermissionsService } from '@bge/permissions';
import { createActors, type Actors } from '@bge/testing-e2e';
import request from 'supertest';
import { createMemberClient } from '../household/household-request';
import { permissionsCacheReadRaw, permissionsCacheWriteRaw } from '../support/api-cache';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const HOUSEHOLDS_PATH = '/api/households';

/**
 * A permission graph that reaches the cache after the eviction meant to
 * remove it (#588).
 *
 * A request loads its caller's graph from the database, then caches it. When
 * the caller's grants change in between, the change's eviction can run before
 * that write. Deleting the key then removes nothing, and the graph written
 * after it is served until the TTL.
 *
 * Over HTTP that window is one request's load, too short to time. So this
 * replays it: it copies the graph the api cached while the member still
 * belonged, lets the removal evict, and writes the copy back. Those are the
 * bytes the late write would have landed, and the api must not serve them.
 */
describe('a permission graph written to the cache after its eviction', () => {
  const baseUrl = requireBaseUrl(process.env);

  const { removeMember } = createMemberClient(baseUrl);

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  it('is not served to a member removed after it was loaded', async () => {
    // Actors first, roster before any of them issues an authenticated request:
    // the ability cache populates lazily per user (#272).
    const owner = await actors.user();
    const member = await actors.user();

    const fixture = await actors.householdWithMembers({
      owner,
      name: 'Removal replayed',
      members: [{ actor: member, role: SystemRole.HouseholdMember }],
    });
    const [membership] = fixture.members;
    const householdPath = `${HOUSEHOLDS_PATH}/${fixture.household.id}`;
    const graphKey = PermissionsService.userGraphCacheKey(member.user.id);

    await request(baseUrl).get(householdPath).set(member.headers).expect(200);
    const loadedAsMember = await permissionsCacheReadRaw(graphKey);

    await removeMember(owner, fixture.household.id, membership.member.id).expect(200);

    // A key this spec spelled wrong reads null, and the replay below would
    // then write a value the api never reads.
    expect(loadedAsMember).not.toBeNull();
    await permissionsCacheWriteRaw(graphKey, loadedAsMember as string, PermissionsService.CACHE_TTL_IN_MILLISECONDS);

    // 403, not 404: the household still exists, and this caller may no longer
    // see it, the same answer any non-member gets (household-authorization).
    await request(baseUrl).get(householdPath).set(member.headers).expect(403);
  });
});
