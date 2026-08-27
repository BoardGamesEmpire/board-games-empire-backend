import { PluginCategory, PluginGrantStatus, PluginScope, RiskLevel, type Plugin } from '@bge/database';
import { createActors, type Actors } from '@bge/testing-e2e';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { expectAdvisoryWaiter, withBarrier, type Barrier } from '../support/lock-barrier';
import { bindTemplate, readShippedSql, readShippedValue } from '../support/shipped-sql';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { LOCK_SOURCES } from './lock-order';
import { MANAGE_DIGEST_CHECK, type Check } from './manifest-checks';

/**
 * The race a row lock cannot reach: two transactions writing a unit's state
 * before the unit row exists (#360 step 5).
 *
 * `FOR UPDATE` on a row that does not exist locks nothing, so a creator and a
 * concurrent decision are invisible to each other — each reads "no row" past
 * the other's uncommitted INSERT under READ COMMITTED, and both commit
 * believing they were alone. That is the whole reason every unit writer takes
 * the `(scopeId, pluginId)` advisory key first (#323), and it is the one claim
 * the mechanics tier could not test: the key's own suite shows two barrier
 * connections queueing on it, which says nothing about whether the application
 * takes it on the path that creates the row.
 *
 * So these cases contend a barrier against a REQUEST. The barrier holds the key
 * the application would take; the request is a real enable or a real decision,
 * over HTTP, on a unit that does not exist yet.
 *
 * Proving it waited is the interesting part. The API's backend is not knowable
 * from here — the request runs on a connection from its own pool, and this
 * suite never imports application code — so `expectAdvisoryWaiter` asks the
 * question from the holder's side: is anyone queued behind the key I hold, and
 * what are they running? A request that never reached the lock, or took a
 * different key, produces no waiter and fails.
 */
describe('the pre-row races (#360)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const UNIT_SCOPE_LOCK = LOCK_SOURCES.unitScopeLock;

  /**
   * Generous on purpose. The request has to clear a session lookup, a policy
   * guard and a manifest revalidation before it reaches the lock, and the
   * harness already concedes first-touch latency is seconds-scale — so a budget
   * sized for a barrier statement would report a cold start as a lock defect.
   * A request that ANSWERS is reported immediately by `settledEarly`, so the
   * long deadline only ever costs time on a genuinely stuck run.
   */
  const REQUEST_REACHES_LOCK_MS = 20_000;

  const householdLock = readShippedSql(UNIT_SCOPE_LOCK, ['scopeKey'], {
    after: 'lockHouseholdUnitScope',
    matching: /pg_advisory_xact_lock/,
  });
  const userLock = readShippedSql(UNIT_SCOPE_LOCK, ['scopeKey'], {
    after: 'lockUserUnitScope',
    matching: /pg_advisory_xact_lock/,
  });
  const householdKeyFormat = readShippedValue(UNIT_SCOPE_LOCK, ['householdId', 'pluginId'], {
    after: 'lockHouseholdUnitScope',
  });
  const userKeyFormat = readShippedValue(UNIT_SCOPE_LOCK, ['userId', 'pluginId'], { after: 'lockUserUnitScope' });

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const HOUSEHOLD_CHECK: Check = {
    slug: 'read:household_member',
    required: false,
    reason: { en: 'Addresses the digest to the household roster.' },
    consentScope: 'household',
  };

  const USER_CHECK: Check = {
    slug: 'update:user:profile:own',
    required: false,
    reason: { en: 'Records a delivery preference on the profile.' },
    consentScope: 'user',
  };

  /**
   * The same arrangement the C4 suites use, minus everything these cases do not
   * touch. The household check is OPTIONAL here on purpose: a required one
   * would make the enable born-suspended, and this is a test about WAITING, not
   * about what the row is born as.
   */
  const arrangePlugin = async (): Promise<Plugin> => {
    const manifest = buildPluginManifest({
      scope: 'household',
      bgeCompat: '>=0.0.0',
      permissions: { checks: [MANAGE_DIGEST_CHECK, HOUSEHOLD_CHECK, USER_CHECK] },
    });

    const plugin = await db.client.plugin.create({
      data: {
        slug: manifest.slug,
        version: manifest.version,
        category: PluginCategory.FeedbackSink,
        scope: PluginScope.Household,
        manifestJson: manifest as never,
        enabled: true,
        bundled: false,
        installedSha256: randomUUID(),
      },
    });
    await db.client.pluginPermission.create({
      data: { pluginId: plugin.id, slug: `plugin|${plugin.slug}|manage:digest`, riskLevel: RiskLevel.Low },
    });

    return plugin;
  };

  /**
   * Fires a request that is expected to BLOCK, and keeps hold of it safely.
   *
   * Two things the call sites must not get wrong. A promise nobody has attached
   * a handler to becomes an unhandled rejection the moment an assertion between
   * here and the await throws — the same hazard `issue()` guards for barrier
   * statements. And a request that answers early is a fixture problem wearing a
   * lock problem's clothes, so its outcome is offered to `expectAdvisoryWaiter`
   * as the thing to report instead of a timeout.
   */
  const fire = (send: () => request.Test) => {
    let outcome: string | undefined;
    const settled = send().then(
      (response) => {
        outcome = `HTTP ${response.status}`;

        return response;
      },
      (error: unknown) => {
        outcome = `it failed: ${error instanceof Error ? error.message : String(error)}`;
        throw error;
      },
    );

    settled.catch(() => undefined);

    return { settled, settledEarly: () => outcome };
  };

  /** The barrier's own backends, which are never the request under test. */
  const barrierPids = (barrier: Barrier): number[] => [barrier.waiter.pid, barrier.observer.pid];

  it('makes a household enable wait for the key, on a unit that does not exist yet', async () => {
    const owner = await actors.user();
    const { household } = await actors.householdWithMembers({ owner });
    const plugin = await arrangePlugin();
    const key = bindTemplate(householdKeyFormat, [household.id, plugin.id]);

    expect(await db.client.householdPlugin.count({ where: { pluginId: plugin.id } })).toBe(0);

    await withBarrier(async (barrier) => {
      const { holder } = barrier;

      await holder.begin();
      await holder.query(householdLock.text, [key]);

      // Deliberately not awaited: it is supposed to be stuck.
      const enable = fire(() =>
        request(baseUrl)
          .post(`/api/households/${household.id}/plugins/${plugin.slug}/enable`)
          .set(owner.headers)
          .send({}),
      );

      const waiter = await expectAdvisoryWaiter(barrier, {
        heldBy: holder.pid,
        description: 'the household enable request',
        timeoutMs: REQUEST_REACHES_LOCK_MS,
        exclude: barrierPids(barrier),
        settledEarly: enable.settledEarly,
      });

      // Not merely "someone is queued": the backend behind us is running the
      // advisory statement the application ships, which is what says the enable
      // path takes this key rather than arriving here some other way.
      expect(waiter.query).toContain('pg_advisory_xact_lock');

      // Released before anything else is asked of the database. The waiting
      // request is inside a Prisma interactive transaction on the default 5s
      // budget, and every question asked while the key is held spends it — an
      // expired budget surfaces as a 500 and reads as a lock failure.
      await holder.commit();

      const response = await enable.settled;

      expect(response.status).toBe(200);
      expect(await db.client.householdPlugin.count({ where: { pluginId: plugin.id } })).toBe(1);
    });
  });

  it('does not make another household wait — the key is per unit', async () => {
    // The control. Holding one household's key while every OTHER household
    // queues behind it would pass the case above and be a serialization bug.
    const owner = await actors.user();
    const otherOwner = await actors.user();
    const { household } = await actors.householdWithMembers({ owner });
    const { household: other } = await actors.householdWithMembers({ owner: otherOwner });
    const plugin = await arrangePlugin();

    await withBarrier(async (barrier) => {
      const { holder } = barrier;

      await holder.begin();
      await holder.query(householdLock.text, [bindTemplate(householdKeyFormat, [household.id, plugin.id])]);

      const response = await request(baseUrl)
        .post(`/api/households/${other.id}/plugins/${plugin.slug}/enable`)
        .set(otherOwner.headers)
        .send({});

      expect(response.status).toBe(200);

      await holder.commit();
    });
  });

  it('makes a granted user decision wait for the key it creates the anchor behind', async () => {
    // The user-scope twin, and the site the advisory scheme was introduced for:
    // the consent act IS the enabling act (#225), so `decide()` creates the
    // anchor row inside the decision transaction. Before the row exists, the
    // key is the only thing ordering that creation against a concurrent writer.
    const user = await actors.user();
    const plugin = await arrangePlugin();
    const key = bindTemplate(userKeyFormat, [user.user.id, plugin.id]);

    await withBarrier(async (barrier) => {
      const { holder } = barrier;

      await holder.begin();
      await holder.query(userLock.text, [key]);

      const decision = fire(() =>
        request(baseUrl)
          .post(`/api/users/me/plugins/${plugin.slug}/grants`)
          .set(user.headers)
          .send({ permissionSlug: USER_CHECK.slug, status: PluginGrantStatus.Granted }),
      );

      const waiter = await expectAdvisoryWaiter(barrier, {
        heldBy: holder.pid,
        description: 'the granted user decision',
        timeoutMs: REQUEST_REACHES_LOCK_MS,
        exclude: barrierPids(barrier),
        settledEarly: decision.settledEarly,
      });

      expect(waiter.query).toContain('pg_advisory_xact_lock');

      await holder.commit();

      const response = await decision.settled;

      expect(response.status).toBe(200);
      expect(await db.client.userPlugin.count({ where: { userId: user.user.id, pluginId: plugin.id } })).toBe(1);
    });
  });
});
