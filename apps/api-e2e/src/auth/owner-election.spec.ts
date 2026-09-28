import { SystemRole } from '@bge/database';
import { performSignup, waitForProvisionedRoleNames, type SignupResult } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import { requireBaseUrl } from '../support/e2e-env';
import { expectBackendsQueuedBehind, withBarrier } from '../support/lock-barrier';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { holdProvisioningAtRoleWrite } from './lock-fixtures';

const OWNER_ROLE_SET = [SystemRole.Owner, SystemRole.User].sort().join(', ');

/**
 * The Owner election (#430), over the real signup route.
 *
 * better-auth commits the user row before its `create.after` hook emits the
 * event provisioning listens for, so two first signups can both be committed
 * before either handler has looked. An election that counts human rows sees
 * two and elects nobody, which leaves the install without an Owner for good.
 * The election has to read what provisioning itself writes: the seat is taken
 * once a human holds a global role.
 *
 * These sign up through `performSignup` rather than the actor factories:
 * every factory mints the Owner sentinel first, and the seat is what is under
 * test. The between-test sweep leaves each test an install with no users.
 */
describe('Owner election at signup', () => {
  const baseUrl = requireBaseUrl(process.env);

  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  const provisionedRoleSet = async (signup: SignupResult): Promise<string> =>
    (await waitForProvisionedRoleNames(db.client, signup.userId, signup.username)).join(', ');

  it('elects the first human provisioned, even when another human row was committed first', async () => {
    // The race's other signup, frozen after its row committed and before its
    // handler ran. No timing involved: the row simply exists, unprovisioned,
    // when this signup's handler holds its election.
    const unique = randomUUID().replaceAll('-', '').slice(0, 12);
    await db.client.user.create({
      data: { username: `e2e-unprovisioned-${unique}`, email: `e2e-unprovisioned-${unique}@e2e.invalid` },
    });

    const signup = await performSignup(baseUrl);

    expect(await provisionedRoleSet(signup)).toBe(OWNER_ROLE_SET);
  });

  it('elects exactly one Owner when two first signups hold their elections at the same time', async () => {
    await withBarrier(async (barrier) => {
      const { holder } = barrier;

      // Neither signup can write its election until both have got as far as
      // they can: without the election lock, both have already decided they
      // are first. With it, the second waits on the first.
      await holdProvisioningAtRoleWrite(holder);

      const signups = await Promise.all([performSignup(baseUrl), performSignup(baseUrl)]);

      await expectBackendsQueuedBehind(barrier, {
        heldBy: holder.pid,
        count: 2,
        description: 'both signups’ provisioning',
      });

      await holder.commit();

      const roleSets = await Promise.all(signups.map(provisionedRoleSet));

      expect(roleSets.sort()).toEqual([OWNER_ROLE_SET, SystemRole.User]);
    });
  });
});
