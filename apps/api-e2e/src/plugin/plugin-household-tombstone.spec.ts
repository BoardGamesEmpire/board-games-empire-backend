import { PluginGrantScope, PluginGrantStatus, PluginScope, RiskLevel, type Plugin } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import request from 'supertest';
import { SOFT_DELETE_HOUSEHOLD } from '../household/lock-fixtures';
import type { Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { expectLockWaiter, withBarrier, type Barrier } from '../support/lock-barrier';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import {
  readConsentSurface,
  reviewBody,
  sendReview,
  sendSwitchOn,
  sendToggle,
  switchOnBody,
  toggleBody,
  type ConsentSurface,
} from './consent-act-fixtures';
import { MANAGE_DIGEST_CHECK, type Check } from './manifest-checks';
import { householdPluginKey } from './plugin-api-key';
import { pluginRowData } from './plugin-row-fixtures';

/**
 * #548's acceptance over HTTP: a household plugin write that passed every check
 * in front of its transaction, racing a soft-delete that commits first.
 *
 * The admin check reads membership without a lock, so a delete committing
 * between it and the write used to leave a unit enablement, or a consent
 * decision, on a household the API treats as gone. Since #1150 both are
 * written by a consent act, so the writes here are the three acts. Each write now opens its
 * transaction with the household's share lock, which is what these cases drive.
 *
 * The barrier holds a real soft-delete open. Every read in front of the lock is
 * a plain MVCC read, so it sees the household live and does not wait; the
 * request reaches its transaction and queues on the household row.
 * `expectLockWaiter` proves it queued there, and the running statement proves
 * which lock it queued on. Then the delete commits, and the request must come
 * back refused with nothing written: 404 to the owner, and 403 to the owner's
 * API key, which the route never tells which households exist.
 *
 * Same harness as `household/role-transition-tombstone.spec.ts`, which drives
 * the role transitions through the same race.
 */
describe('household plugin writes racing a soft-delete (#548)', () => {
  const baseUrl = requireBaseUrl(process.env);

  /**
   * Generous on purpose: a request clears a session lookup, the route guards
   * and a manifest revalidation before it reaches the lock, and a cold start is
   * seconds-scale. A request that answers is reported at once by
   * `settledEarly`, so the long budget only costs time on a stuck run.
   */
  const REQUEST_REACHES_LOCK_MS = 20_000;

  /** An allowlisted public read, which a household-scope consent may hold (#591). */
  const HOUSEHOLD_CHECK: Check = {
    slug: 'read:game:public',
    required: false,
    reason: { en: 'Lists the public games the household digest features.' },
    consentScope: 'household',
  };

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  /** A household-scope plugin with one optional household check, so neither write is refused for consent. */
  const arrangePlugin = async (): Promise<Plugin> => {
    const manifest = buildPluginManifest({
      scope: 'household',
      bgeCompat: '>=0.0.0',
      permissions: { checks: [MANAGE_DIGEST_CHECK, HOUSEHOLD_CHECK] },
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

  interface Arrangement {
    readonly householdId: string;
    readonly owner: SessionActor;
    readonly plugin: Plugin;
    /** The household's consent surface, read while the household was live; every act body is built from it (#1150). */
    readonly surface: ConsentSurface;
  }

  /**
   * A live household and plugin. `switchedOn` arranges the household's unit
   * enablement switched on, on the rows, so that a toggle or a review would
   * succeed there if the household were not deleted under it.
   */
  const arrange = async (switchedOn: boolean): Promise<Arrangement> => {
    const owner = await actors.user();
    const { household } = await actors.householdWithMembers({ owner, name: 'Deleted while a plugin write waits' });
    const plugin = await arrangePlugin();
    const surface = await readConsentSurface(baseUrl, owner, { householdId: household.id }, plugin.slug);

    if (switchedOn) {
      await db.client.householdPlugin.create({
        data: { householdId: household.id, pluginId: plugin.id, enabled: true },
      });
    }

    return { householdId: household.id, owner, plugin, surface };
  };

  /** What a toggle or review would write for the household: an act or a consent decision. */
  const actWrites = async ({ householdId, plugin }: Arrangement): Promise<number> => {
    const scope = { pluginId: plugin.id, scopeType: PluginGrantScope.Household, scopeId: householdId };

    return (
      (await db.client.pluginConsentAct.count({ where: scope })) + (await db.client.pluginGrant.count({ where: scope }))
    );
  };

  /**
   * Each write, sent on behalf of the household's owner, who would succeed on a
   * live household: the toggle and the review find the unit switched on. That
   * is what makes the refusal mean the lock refused it. `code` is the refusal
   * the owner's session gets; `hiddenCode` is the one an actor that cannot
   * tell households apart gets instead. The three consent acts (#1150) open
   * their transaction with the same household share lock.
   */
  const WRITES: readonly {
    readonly name: string;
    readonly code: string;
    readonly hiddenCode: string;
    /** Whether the household's unit enablement is arranged switched on first. */
    readonly switchedOn: boolean;
    readonly send: (a: Arrangement, caller: Caller) => request.Test;
    readonly written: (a: Arrangement) => Promise<number>;
  }[] = [
    {
      name: 'switch-on',
      code: 'PLUGIN_UNIT_HOUSEHOLD_NOT_FOUND',
      hiddenCode: 'PLUGIN_UNIT_AUTHORITY',
      switchedOn: false,
      send: ({ householdId, plugin, surface }, caller) =>
        sendSwitchOn(baseUrl, caller, { householdId }, plugin.slug, switchOnBody(surface)),
      // An act, a consent decision, or the unit enablement a switch-on creates.
      written: async (a) =>
        (await actWrites(a)) +
        (await db.client.householdPlugin.count({ where: { householdId: a.householdId, pluginId: a.plugin.id } })),
    },
    {
      name: 'toggle',
      code: 'PLUGIN_UNIT_HOUSEHOLD_NOT_FOUND',
      hiddenCode: 'PLUGIN_UNIT_AUTHORITY',
      switchedOn: true,
      send: ({ householdId, plugin, surface }, caller) =>
        sendToggle(
          baseUrl,
          caller,
          { householdId },
          plugin.slug,
          toggleBody(surface, HOUSEHOLD_CHECK.slug, PluginGrantStatus.Granted),
        ),
      written: actWrites,
    },
    {
      name: 'review',
      code: 'PLUGIN_UNIT_HOUSEHOLD_NOT_FOUND',
      hiddenCode: 'PLUGIN_UNIT_AUTHORITY',
      switchedOn: true,
      send: ({ householdId, plugin, surface }, caller) =>
        sendReview(
          baseUrl,
          caller,
          { householdId },
          plugin.slug,
          reviewBody(surface, { [HOUSEHOLD_CHECK.slug]: PluginGrantStatus.Granted }),
        ),
      written: actWrites,
    },
  ];

  /** The barrier's own backends, which are never the request under test. */
  const barrierPids = (barrier: Barrier): number[] => [barrier.waiter.pid, barrier.observer.pid];

  /**
   * Fires a request that is expected to BLOCK, and keeps hold of it safely: the
   * pending response is pre-handled so an assertion failing before it is
   * awaited cannot surface as an unhandled rejection, and its outcome is
   * offered to `expectLockWaiter`, so a request that answers early is reported
   * as answered rather than as a timeout.
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

  /**
   * Holds a soft-delete of the arranged household open, sends the write, proves
   * it queued on the household's share lock, then commits the delete and hands
   * back the write's response.
   */
  const raceTheDelete = (
    { householdId }: Arrangement,
    name: string,
    send: () => request.Test,
  ): Promise<request.Response> =>
    withBarrier(async (barrier) => {
      const { holder } = barrier;

      await holder.begin();
      await expect(holder.query(SOFT_DELETE_HOUSEHOLD, [householdId])).resolves.toHaveLength(1);

      // Deliberately not awaited: it is supposed to be stuck.
      const pending = fire(send);

      const waiter = await expectLockWaiter(barrier, {
        heldBy: holder.pid,
        description: `the ${name} request`,
        timeoutMs: REQUEST_REACHES_LOCK_MS,
        exclude: barrierPids(barrier),
        settledEarly: pending.settledEarly,
      });

      // Queued on the household's share lock specifically, the statement whose
      // re-check this suite is about, and not on some plugin lock behind it.
      expect(waiter.query).toMatch(/FROM households h[\s\S]*FOR SHARE/);

      // Released before anything else is asked of the database: the request is
      // inside an interactive transaction on the default 5s budget, and an
      // expired budget surfaces as a 500 that reads as a lock failure.
      await holder.commit();

      return pending.settled;
    });

  it.each(WRITES)('answers 404 for a $name that queued behind the soft-delete', async (write) => {
    const arrangement = await arrange(write.switchedOn);

    const response = await raceTheDelete(arrangement, write.name, () => write.send(arrangement, arrangement.owner));

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: write.code, householdId: arrangement.householdId });
    await expect(write.written(arrangement)).resolves.toBe(0);
  });

  /**
   * The same race, sent through the owner's API key, which holds no read on
   * Household. The route's liveness guard never tells that key which households
   * exist, and once the delete lands it is refused 403 on this household
   * (`household-plugins-liveness.spec.ts`). Losing the race reads the same:
   * the 403 the admin check gives anyone who is not the household's admin.
   */
  it.each(WRITES)(
    "answers 403 to the owner's API key with no household read, for a $name that queued behind the soft-delete",
    async (write) => {
      const arrangement = await arrange(write.switchedOn);
      const key = await householdPluginKey(baseUrl, db.client, arrangement.owner);

      const response = await raceTheDelete(arrangement, write.name, () => write.send(arrangement, key));

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: write.hiddenCode });
      expect(response.body).not.toHaveProperty('householdId');
      await expect(write.written(arrangement)).resolves.toBe(0);
    },
  );
});
