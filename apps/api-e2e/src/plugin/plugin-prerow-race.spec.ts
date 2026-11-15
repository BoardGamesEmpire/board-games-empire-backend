import { PluginGrantStatus, PluginScope, RiskLevel, type Plugin } from '@bge/database';
import { createActors, type Actors } from '@bge/testing-e2e';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { expectAdvisoryWaiter, withBarrier, type Barrier } from '../support/lock-barrier';
import { bindTemplate, readShippedSql, readShippedValue } from '../support/shipped-sql';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { readConsentSurface, sendSwitchOn, switchOnBody } from './consent-act-fixtures';
import { LOCK_SOURCES } from './lock-order';
import { MANAGE_DIGEST_CHECK, type Check } from './manifest-checks';
import { pluginRowData } from './plugin-row-fixtures';

/**
 * The race a row lock cannot reach: two transactions writing a unit's state
 * before the unit row exists (#360 step 5).
 *
 * `FOR UPDATE` on a row that does not exist locks nothing, so a creator and a
 * concurrent decision are invisible to each other — each reads "no row" past
 * the other's uncommitted INSERT under READ COMMITTED, and both commit
 * believing they were alone. That is the whole reason every unit writer takes
 * the `(scopeId, pluginId)` advisory key before the unit enablement (#323), and it is the one claim
 * the mechanics tier could not test: the key's own suite shows two barrier
 * connections queueing on it, which says nothing about whether the application
 * takes it on the path that creates the row.
 *
 * So these cases contend a barrier against a REQUEST. The barrier holds the key
 * the application would take; the request is a real switch-on, a consent act
 * (#1150), over HTTP, on a unit that does not exist yet.
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

  /** An allowlisted public read, which a household-scope consent may hold (#591). */
  const HOUSEHOLD_CHECK: Check = {
    slug: 'read:game:public',
    required: false,
    reason: { en: 'Lists the public games the household digest features.' },
    consentScope: 'household',
  };

  /** An allowlisted public read, which a user-scope consent may hold (#591). */
  const USER_CHECK: Check = {
    slug: 'read:game_collection:public',
    required: false,
    reason: { en: 'Shows public collections in the digest.' },
    consentScope: 'user',
  };

  /**
   * The same arrangement the C4 suites use, minus everything these cases do not
   * touch. The household check is OPTIONAL here on purpose: this is a test
   * about WAITING, and a required one would only add a review pending to a
   * consent standing these cases never read (#1149).
   */
  const arrangePlugin = async (): Promise<Plugin> => {
    const manifest = buildPluginManifest({
      scope: 'household',
      bgeCompat: '>=0.0.0',
      permissions: { checks: [MANAGE_DIGEST_CHECK, HOUSEHOLD_CHECK, USER_CHECK] },
    });

    const plugin = await db.client.plugin.create({
      data: pluginRowData({
        slug: manifest.slug,
        version: manifest.version,
        scope: PluginScope.Household,
        manifestJson: manifest as never,
        enabled: true,
      }),
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

  it('makes a household switch-on wait for the key, on a unit that does not exist yet (#1150)', async () => {
    const owner = await actors.user();
    const { household } = await actors.householdWithMembers({ owner });
    const plugin = await arrangePlugin();
    const key = bindTemplate(householdKeyFormat, [household.id, plugin.id]);

    expect(await db.client.householdPlugin.count({ where: { pluginId: plugin.id } })).toBe(0);

    // Read before the key is held: the consent surface takes no lock, and the
    // act body is built from it rather than from constants (#1150).
    const unit = { householdId: household.id };
    const surface = await readConsentSurface(baseUrl, owner, unit, plugin.slug);

    await withBarrier(async (barrier) => {
      const { holder } = barrier;

      await holder.begin();
      await holder.query(householdLock.text, [key]);

      // Deliberately not awaited: it is supposed to be stuck.
      const enable = fire(() => sendSwitchOn(baseUrl, owner, unit, plugin.slug, switchOnBody(surface)));

      const waiter = await expectAdvisoryWaiter(barrier, {
        heldBy: holder.pid,
        description: 'the household switch-on',
        timeoutMs: REQUEST_REACHES_LOCK_MS,
        exclude: barrierPids(barrier),
        settledEarly: enable.settledEarly,
      });

      // Not merely "someone is queued": the backend behind us is running the
      // advisory statement the application ships, which is what says the
      // switch-on takes this key rather than arriving here some other way.
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
    const otherUnit = { householdId: other.id };
    const surface = await readConsentSurface(baseUrl, otherOwner, otherUnit, plugin.slug);

    await withBarrier(async (barrier) => {
      const { holder } = barrier;

      await holder.begin();
      await holder.query(householdLock.text, [bindTemplate(householdKeyFormat, [household.id, plugin.id])]);

      const response = await sendSwitchOn(baseUrl, otherOwner, otherUnit, plugin.slug, switchOnBody(surface));

      expect(response.status).toBe(200);

      await holder.commit();
    });
  });

  it("makes a user's switch-on wait for the key it creates the unit enablement behind (#1150)", async () => {
    // The user-scope twin, and the site the advisory scheme was introduced for:
    // the consent act is the enabling act (#225), so the user's switch-on
    // writes the user's consent decisions and creates the user's unit
    // enablement in one transaction (#1150). Before the row exists, the key is
    // the only thing ordering that creation against a concurrent writer.
    const user = await actors.user();
    const plugin = await arrangePlugin();
    const key = bindTemplate(userKeyFormat, [user.user.id, plugin.id]);
    const surface = await readConsentSurface(baseUrl, user, 'me', plugin.slug);

    await withBarrier(async (barrier) => {
      const { holder } = barrier;

      await holder.begin();
      await holder.query(userLock.text, [key]);

      const decision = fire(() =>
        sendSwitchOn(
          baseUrl,
          user,
          'me',
          plugin.slug,
          switchOnBody(surface, { [USER_CHECK.slug]: PluginGrantStatus.Granted }),
        ),
      );

      const waiter = await expectAdvisoryWaiter(barrier, {
        heldBy: holder.pid,
        description: "the user's switch-on",
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
