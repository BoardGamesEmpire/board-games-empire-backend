import { PermissionsService } from '@bge/permissions';
import { createActors, performSignup, waitForProvisionedRoleNames, type Actors } from '@bge/testing-e2e';
import request from 'supertest';
import { apiCacheHas } from '../support/api-cache';
import { requireBaseUrl } from '../support/e2e-env';
import { expectBackendsQueuedBehind, withBarrier } from '../support/lock-barrier';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { holdProvisioningAtRoleWrite } from './lock-fixtures';

const HOUSEHOLDS_PATH = '/api/households';

/**
 * A request that lands between the signup response and the provisioning
 * commit (#490).
 *
 * Provisioning runs after the signup response and asynchronously, so a client
 * can send a request while the user holds no role yet. That request is refused,
 * which is correct. What must not happen is the graph it loaded, with no roles
 * in it, staying cached for the full TTL and refusing the user long after
 * provisioning has written their roles.
 */
describe('a request sent before signup provisioning commits', () => {
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

  it('is refused without leaving a role-less graph cached past provisioning', async () => {
    // The seat is taken first, so this signup is provisioned the ordinary way.
    await actors.owner();

    await withBarrier(async (barrier) => {
      const { holder } = barrier;

      await holdProvisioningAtRoleWrite(holder);

      const signup = await performSignup(baseUrl);
      const headers = { Authorization: `Bearer ${signup.token}` };

      await expectBackendsQueuedBehind(barrier, {
        heldBy: holder.pid,
        count: 1,
        description: 'the signup’s provisioning',
      });

      const early = await request(baseUrl).get(HOUSEHOLDS_PATH).set(headers);

      // Read while provisioning is still held, so no eviction after its commit
      // can have run yet. The later request alone cannot tell "nothing stale
      // was cached" from "something stale was cached and then evicted".
      const cachedWhilePending = await apiCacheHas(PermissionsService.userGraphCacheKey(signup.userId));

      await holder.commit();
      await waitForProvisionedRoleNames(db.client, signup.userId, signup.username);

      const later = await request(baseUrl).get(HOUSEHOLDS_PATH).set(headers);

      // The same read once caching should happen, so a key this spec spells
      // wrong fails here instead of passing the pending read for nothing.
      // Provisioning's eviction cannot undo it: it runs straight after the
      // commit, while this request still had its graph to load.
      const cachedOnceProvisioned = await apiCacheHas(PermissionsService.userGraphCacheKey(signup.userId));

      expect({ early: early.status, cachedWhilePending, later: later.status, cachedOnceProvisioned }).toEqual({
        early: 403,
        cachedWhilePending: false,
        later: 200,
        cachedOnceProvisioned: true,
      });
    });
  });
});
