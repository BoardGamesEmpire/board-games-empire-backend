import {
  PluginConsentActKind,
  PluginGrantScope,
  PluginGrantStatus,
  PluginScope,
  RiskLevel,
  type Plugin,
} from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { buildPluginManifest, type PluginManifest } from '@boardgamesempire/plugin-manifest';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { expectBackendsQueuedBehind, expectLockWaiter, withBarrier } from '../support/lock-barrier';
import { bindTemplate, readShippedSql, readShippedValue } from '../support/shipped-sql';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { readConsentSurface, sendSwitchOn, sendToggle, switchOnBody, toggleBody } from './consent-act-fixtures';
import { LOCK_SOURCES } from './lock-order';
import { MANAGE_DIGEST_CHECK, type Check } from './manifest-checks';
import { INVENTORY_STAGING_ID, pluginRowData, stagedUpdateColumns } from './plugin-row-fixtures';

/**
 * The invariants, raced over HTTP (#360 tier 1).
 *
 * These are the cheap ones, and they exercise the real code end to end rather
 * than a replay of its statements: two requests at once, then an assertion
 * about the state they left behind. Invariants of this shape were found
 * VIOLATED during PR #359's review rounds, and none was caught by a test,
 * because no test at this tier existed. Since #1150 every household and user
 * consent decision is written by a consent act, so the household cases race
 * two acts on one unit: opposite answers are both recorded and the surviving
 * decision is the one the later act gave, and identical answers record one act.
 *
 * Two rules these cases follow, and both are about staying useful rather than
 * becoming flaky (#330):
 *
 *  - **Two requests, never more.** The throttle keys on handler plus IP, so a
 *    burst lands in this endpoint's shared bucket alongside every other spec
 *    that posts to it, and a wide one measures the rate limiter rather than the
 *    invariant. The warning is written out at `household-idempotency.spec.ts`,
 *    and #293 is why that pin matters.
 *  - **Invariant-shaped assertions only.** What is asserted is the set of end
 *    states that are legal, never which contender won. A race whose winner is
 *    asserted is a test that fails on a fast machine for being right.
 *
 * What these cases cannot show is that anything BLOCKED. A green run here is
 * consistent with the locks having done nothing and the interleaving simply
 * being kind, which is why the barrier specs exist beside them and why neither
 * tier is redundant. The cases here that hold a barrier do so only to have two
 * requests in flight at once, or in a known order, not to prove a lock.
 */
describe('consent decisions under concurrency (#360)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const PLUGINS_PATH = '/api/plugins';
  const STAGED_AT = new Date('2026-08-01T12:00:00Z');

  /**
   * As in the pre-row race: generous, because a request has to clear its
   * guards and a manifest revalidation before it reaches the lock, and one that
   * answers early is reported at once rather than at the deadline.
   */
  const REQUEST_REACHES_LOCK_MS = 20_000;

  /**
   * A household unit's advisory key, its statement and its format lifted from
   * source rather than retyped: a key nothing contends for blocks nobody, and
   * the case holding it would pass for the wrong reason.
   */
  const unitKeyLock = readShippedSql(LOCK_SOURCES.unitScopeLock, ['scopeKey'], {
    after: 'lockHouseholdUnitScope',
    matching: /pg_advisory_xact_lock/,
  });
  const unitKeyFormat = readShippedValue(LOCK_SOURCES.unitScopeLock, ['householdId', 'pluginId'], {
    after: 'lockHouseholdUnitScope',
  });

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const POLICY_READ_CHECK: Check = {
    slug: 'read:safe_http_policy',
    required: false,
    reason: { en: 'Inspects the outbound policy before scheduling delivery.' },
    consentScope: 'server',
  };

  /**
   * REQUIRED at household scope, so a household switch-on must answer it. An
   * allowlisted public read, which a household-scope consent may hold (#591).
   */
  const HOUSEHOLD_CHECK: Check = {
    slug: 'read:game:public',
    required: true,
    reason: { en: 'Lists the public games the household digest features.' },
    consentScope: 'household',
  };

  /** The household check made OPTIONAL, so a toggle may answer it either way (#1150). */
  const OPTIONAL_HOUSEHOLD_CHECK: Check = { ...HOUSEHOLD_CHECK, required: false };

  const manifestWith = (version: string, checks: readonly Check[]): PluginManifest =>
    buildPluginManifest({
      version,
      scope: 'household',
      bgeCompat: '>=0.0.0',
      permissions: { checks: [...checks] },
    });

  const arrangePlugin = async (
    checks: readonly Check[] = [MANAGE_DIGEST_CHECK, POLICY_READ_CHECK, HOUSEHOLD_CHECK],
    overrides: Record<string, unknown> = {},
  ): Promise<Plugin> => {
    const active = manifestWith('1.2.0', checks);

    const plugin = await db.client.plugin.create({
      data: pluginRowData({
        slug: active.slug,
        version: active.version,
        scope: PluginScope.Household,
        manifestJson: active as never,
        enabled: true,
        ...overrides,
      }),
    });
    await db.client.pluginPermission.create({
      data: { pluginId: plugin.id, slug: `plugin|${plugin.slug}|manage:digest`, riskLevel: RiskLevel.Low },
    });

    return plugin;
  };

  /**
   * Fires a request expected to block, and keeps hold of it safely: the same
   * helper the pre-row race uses, for the same two reasons. A promise nobody
   * has handled becomes an unhandled rejection if an assertion throws first,
   * and a request that answers early is reported as answered, not as a timeout.
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

  const decideServer = (actor: SessionActor, slug: string, body: Record<string, unknown>) =>
    request(baseUrl).post(`${PLUGINS_PATH}/${slug}/grants`).set(actor.headers).send(body);

  const unitRow = (householdId: string, pluginId: string) =>
    db.client.householdPlugin.findFirstOrThrow({ where: { householdId, pluginId } });

  const approve = (actor: SessionActor, slug: string) =>
    request(baseUrl)
      .post(`${PLUGINS_PATH}/${slug}/update/approve`)
      .set(actor.headers)
      .send({ stagingId: INVENTORY_STAGING_ID });

  /**
   * A plugin whose household check is optional, switched on for the household
   * WITHOUT answering it, so the unit starts with no consent decision on it.
   * From there each of two racing toggles changes something and writes an act.
   * Had the switch-on answered it, the toggle matching that answer would change
   * nothing and record no act (#1150).
   */
  const arrangeSwitchedOnWithPendingOptional = async (owner: SessionActor, householdId: string) => {
    const plugin = await arrangePlugin([MANAGE_DIGEST_CHECK, POLICY_READ_CHECK, OPTIONAL_HOUSEHOLD_CHECK]);
    const unit = { householdId };
    const surface = await readConsentSurface(baseUrl, owner, unit, plugin.slug);

    await sendSwitchOn(baseUrl, owner, unit, plugin.slug, switchOnBody(surface)).expect(200);

    return { plugin, unit, surface };
  };

  /**
   * The racing toggles' invariant: both answered 200, the unit holds exactly
   * two acts and one consent decision on the permission, and that decision's
   * `actId` and `status` belong to the SAME act. The act's stored presentation
   * is what says which answer it gave. Which act won is the race's business and
   * is never asserted.
   */
  const expectBothActsRecordedAndOneWins = async (
    responses: readonly { readonly status: number }[],
    plugin: Plugin,
    householdId: string,
    unitUpdatedBefore: Date,
  ) => {
    // Asserted as a pair rather than chained, so a 500 reports its status.
    expect(responses.map((response) => response.status)).toEqual([200, 200]);

    // The arrangement's switch-on is an act of its own, so the two racing
    // toggles are counted by kind.
    const acts = await db.client.pluginConsentAct.findMany({
      where: {
        pluginId: plugin.id,
        scopeType: PluginGrantScope.Household,
        scopeId: householdId,
        kind: PluginConsentActKind.Toggle,
      },
    });

    expect(acts).toHaveLength(2);

    const decisions = await db.client.pluginGrant.findMany({
      where: {
        pluginId: plugin.id,
        scopeType: PluginGrantScope.Household,
        scopeId: householdId,
        permissionSlug: OPTIONAL_HOUSEHOLD_CHECK.slug,
      },
    });

    // One row, not two: the upsert is what makes the loser update rather than
    // collide, and a P2002 here would have surfaced as a 500 above.
    expect(decisions).toHaveLength(1);

    const decision = decisions[0];
    const winner = acts.find((act) => act.id === decision?.actId);

    expect(winner).toBeDefined();

    const presentation = winner?.presentation as { checks: { slug: string; outcome: string }[] } | undefined;
    const answered = presentation?.checks.find((check) => check.slug === OPTIONAL_HOUSEHOLD_CHECK.slug);

    expect(answered?.outcome).toBe(decision?.status === PluginGrantStatus.Granted ? 'granted' : 'refused');

    // A toggle answers an optional permission and writes no unit enablement.
    const unit = await unitRow(householdId, plugin.id);

    expect(unit.enabled).toBe(true);
    expect(unit.updatedAt).toEqual(unitUpdatedBefore);
  };

  describe('two toggles with opposite answers on one optional household permission', () => {
    it("two acts racing on one unit both commit, one act's answer stands on the permission, and both acts are recorded (#1150)", async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const { plugin, unit, surface } = await arrangeSwitchedOnWithPendingOptional(owner, household.id);
      const before = await unitRow(household.id, plugin.id);

      const responses = await Promise.all([
        sendToggle(
          baseUrl,
          owner,
          unit,
          plugin.slug,
          toggleBody(surface, OPTIONAL_HOUSEHOLD_CHECK.slug, PluginGrantStatus.Granted),
        ),
        sendToggle(
          baseUrl,
          owner,
          unit,
          plugin.slug,
          toggleBody(surface, OPTIONAL_HOUSEHOLD_CHECK.slug, PluginGrantStatus.Denied),
        ),
      ]);

      await expectBothActsRecordedAndOneWins(responses, plugin, household.id, before.updatedAt);
    });

    it('holds the same invariant when the acts come from different members (#1150)', async () => {
      // The single-actor case shares a session, so both requests could in
      // principle be serialized somewhere above the service. Two admins of the
      // same household remove that explanation.
      const owner = await actors.user();
      const second = await actors.user();
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: second, role: 'HouseholdAdmin' }],
      });
      const { plugin, unit, surface } = await arrangeSwitchedOnWithPendingOptional(owner, household.id);
      const before = await unitRow(household.id, plugin.id);

      const responses = await Promise.all([
        sendToggle(
          baseUrl,
          owner,
          unit,
          plugin.slug,
          toggleBody(surface, OPTIONAL_HOUSEHOLD_CHECK.slug, PluginGrantStatus.Granted),
        ),
        sendToggle(
          baseUrl,
          second,
          unit,
          plugin.slug,
          toggleBody(surface, OPTIONAL_HOUSEHOLD_CHECK.slug, PluginGrantStatus.Denied),
        ),
      ]);

      await expectBothActsRecordedAndOneWins(responses, plugin, household.id, before.updatedAt);
    });
  });

  describe('two identical toggles on one unit', () => {
    it('queue at the unit key, so the later one reads the earlier decision and records no act (#1150)', async () => {
      // An act takes the unit's advisory key before it reads the standing
      // decisions, so of two acts on one unit the later reads what the earlier
      // wrote. Two identical toggles therefore record ONE act: the later one
      // finds its answer already standing and changes nothing. Read before the
      // key, both would pass the check and both would be recorded.
      //
      // The key is held so both requests are in flight before either reads;
      // which one records the act is the race's business and is not asserted.
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const { plugin, unit, surface } = await arrangeSwitchedOnWithPendingOptional(owner, household.id);
      const body = toggleBody(surface, OPTIONAL_HOUSEHOLD_CHECK.slug, PluginGrantStatus.Granted);

      const responses = await withBarrier(async (barrier) => {
        const { holder } = barrier;

        await holder.begin();
        await holder.query(unitKeyLock.text, [bindTemplate(unitKeyFormat, [household.id, plugin.id])]);

        const first = fire(() => sendToggle(baseUrl, owner, unit, plugin.slug, body));
        const second = fire(() => sendToggle(baseUrl, owner, unit, plugin.slug, body));

        await expectBackendsQueuedBehind(barrier, {
          heldBy: holder.pid,
          count: 2,
          description: 'the two identical toggles',
          timeoutMs: REQUEST_REACHES_LOCK_MS,
        });

        // Released at once: both requests wait inside an interactive
        // transaction on its default budget.
        await holder.commit();

        return [await first.settled, await second.settled];
      });

      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(responses.map((response) => response.body.changed as boolean).sort()).toEqual([false, true]);

      const acts = await db.client.pluginConsentAct.findMany({
        where: {
          pluginId: plugin.id,
          scopeType: PluginGrantScope.Household,
          scopeId: household.id,
          kind: PluginConsentActKind.Toggle,
        },
      });

      expect(acts).toHaveLength(1);

      const decision = await db.client.pluginGrant.findFirstOrThrow({
        where: {
          pluginId: plugin.id,
          scopeType: PluginGrantScope.Household,
          scopeId: household.id,
          permissionSlug: OPTIONAL_HOUSEHOLD_CHECK.slug,
        },
      });

      expect(decision).toMatchObject({ status: PluginGrantStatus.Granted, actId: acts[0]?.id });
    });
  });

  describe('an act against an activation', () => {
    it('an act against a manifest a concurrent activation replaces lands under the old sha or is refused (#1150)', async () => {
      // The act's plugin-row claim compares the sha the consent surface named
      // with the row it locks (#1150). Activation holds that row FOR UPDATE
      // while it replaces the manifest, so an act naming the OLD sha either
      // claims the row first and commits under the old sha ahead of the
      // activation, or waits behind it and finds the sha moved. What must never
      // happen is an act recorded under a sha the plugin no longer held.
      const owner = await actors.user();
      const approver = await actors.admin();
      const { household } = await actors.householdWithMembers({ owner });
      const staged = manifestWith('1.3.0', [MANAGE_DIGEST_CHECK, POLICY_READ_CHECK, HOUSEHOLD_CHECK]);
      const plugin = await arrangePlugin(undefined, stagedUpdateColumns({ manifest: staged, since: STAGED_AT }));
      const unit = { householdId: household.id };
      const surface = await readConsentSurface(baseUrl, owner, unit, plugin.slug);
      const oldSha = surface.manifestSha256;

      expect(oldSha).toBe(plugin.installedSha256);

      const { switchOn, activation } = await withBarrier(async (barrier) => {
        const { holder } = barrier;

        // Activation's own plugin-row lock mode, held so both requests queue
        // behind it in a known order: the approval first, then the act. That
        // is the order that puts the act's claim AFTER the manifest moved, so
        // it is the one that exercises the sha comparison; the other order
        // only shows the act committing first, which a missing comparison
        // would pass too.
        await holder.begin();
        await holder.query('SELECT id FROM plugins WHERE id = $1 FOR UPDATE', [plugin.id]);

        const approval = fire(() => approve(approver, plugin.slug));

        await expectLockWaiter(barrier, {
          heldBy: holder.pid,
          description: 'the approval',
          timeoutMs: REQUEST_REACHES_LOCK_MS,
          exclude: [barrier.waiter.pid, barrier.observer.pid],
          settledEarly: approval.settledEarly,
        });

        const act = fire(() =>
          sendSwitchOn(
            baseUrl,
            owner,
            unit,
            plugin.slug,
            switchOnBody(surface, { [HOUSEHOLD_CHECK.slug]: PluginGrantStatus.Granted }),
          ),
        );

        await expectBackendsQueuedBehind(barrier, {
          heldBy: holder.pid,
          count: 2,
          description: 'the approval and the switch-on naming the old sha',
          timeoutMs: REQUEST_REACHES_LOCK_MS,
        });

        // Released before anything else is asked of the database: both
        // requests wait inside a Prisma interactive transaction on its default
        // budget, and every question asked while the row is held spends it.
        await holder.commit();

        return { switchOn: await act.settled, activation: await approval.settled };
      });

      expect(activation.status).toBe(200);

      const activated = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });

      expect(activated.installedSha256).not.toBe(oldSha);

      const acts = await db.client.pluginConsentAct.findMany({ where: { pluginId: plugin.id } });

      // Either legal outcome is accepted, and neither is required.
      if (switchOn.status === 200) {
        // Landed under the old sha, and its insert came ahead of the
        // activation's write to the plugin row. Both stamps are the api's
        // clock, taken as each statement is built, so an act whose claim
        // waited behind the activation would carry the later stamp.
        expect(acts).toHaveLength(1);
        expect(acts[0]?.manifestSha256).toBe(oldSha);
        expect(switchOn.body.act?.id).toBe(acts[0]?.id);
        expect(acts[0]?.createdAt.getTime()).toBeLessThan(activated.updatedAt.getTime());
      } else {
        expect(switchOn.status).toBe(409);
        expect(switchOn.body.code).toBe('PLUGIN_CONSENT_ACT_STALE');
        expect(acts).toHaveLength(0);
      }
    });
  });

  describe('an approval against a server-scope denial', () => {
    it('never activates a manifest over a denial that is already durable', async () => {
      // The pair #356's lock exists for. The active manifest has the policy
      // read OPTIONAL and the staged one requires it, so the denial is legal
      // right up until the approval commits — and illegal under the
      // required-denial rule immediately after. Exactly one of them can win.
      // Two admins, for the reason the household case above gives: one session
      // issuing both requests leaves "something above the service serialized
      // them" as a live explanation for a green run, and this case is the one
      // 356's row lock exists for.
      const admin = await actors.admin();
      const approver = await actors.admin();
      const staged = manifestWith('1.3.0', [
        MANAGE_DIGEST_CHECK,
        { ...POLICY_READ_CHECK, required: true },
        HOUSEHOLD_CHECK,
      ]);
      const plugin = await arrangePlugin(undefined, stagedUpdateColumns({ manifest: staged, since: STAGED_AT }));

      const [denial, activation] = await Promise.all([
        decideServer(admin, plugin.slug, {
          permissionSlug: POLICY_READ_CHECK.slug,
          status: PluginGrantStatus.Denied,
        }),
        approve(approver, plugin.slug),
      ]);

      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      const denialLanded =
        (await db.client.pluginGrant.count({
          where: {
            pluginId: plugin.id,
            permissionSlug: POLICY_READ_CHECK.slug,
            status: PluginGrantStatus.Denied,
          },
        })) > 0;
      const activated = row.version === staged.version;

      // The pair is pinned to the two outcomes that are legal, and nothing
      // else. A weaker form of this — "they were not both 200" — is satisfied
      // by ANY refusal, including a request rejected by a gate in front of the
      // service, so the case could go green having raced nothing at all and
      // stay green with #356's row lock deleted.
      //
      // Which of the two happened is still the race's business, and is never
      // asserted.
      expect([denial.status, activation.status]).toEqual(activation.status === 200 ? [409, 200] : [200, 409]);

      // THE invariant: an activated manifest and a durable denial of one of its
      // required checks cannot both be true. This is the state the required-
      // denial rule exists to make unreachable, and the one a snapshot read
      // instead of a row lock would have let through.
      expect(activated && denialLanded).toBe(false);

      // And the durable state agrees with what each caller was told — a 200
      // that left nothing behind would satisfy the line above for the wrong
      // reason.
      expect(denialLanded).toBe(denial.status === 200);
      expect(activated).toBe(activation.status === 200);

      // Whichever lost, it lost for the documented reason and said so in the
      // typed body the client renders its next step from. A losing denial has
      // two legal codes, by interleaving (#361): one that read the plugin
      // BEFORE activation committed waits on the claim behind activation's
      // FOR UPDATE, finds the plugin manifest moved, and is refused as
      // PluginGrantPluginChangedError; one whose read came AFTER the commit
      // sees the required check at the front door and gets
      // PluginGrantRequiredDenialError.
      const refusal = activation.status === 409 ? activation : denial;

      if (activation.status === 409) {
        expect(refusal.body.code).toBe('PLUGIN_UPDATE_BLOCKED_BY_DENIAL');
      } else {
        expect(['PLUGIN_GRANT_REQUIRED_DENIAL', 'PLUGIN_GRANT_PLUGIN_CHANGED']).toContain(refusal.body.code);
      }

      if (!activated) {
        expect(row.pendingVersion).toBe(staged.version);
      }
    });
  });
});
