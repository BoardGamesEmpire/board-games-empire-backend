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
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import {
  readConsentSurface,
  readStagedShownRisks,
  sendSwitchOn,
  sendToggle,
  switchOnBody,
  toggleBody,
  type ShownRiskBody,
} from './consent-act-fixtures';
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
 * two acts on one unit. Nothing orders two acts on one unit against each other
 * (#1152): each claims the plugin row shared on the sha it names and writes its
 * decisions in permission order, by upsert, so the later write wins on each
 * permission and both acts stay on record. Two opposite toggles both commit,
 * and two first switch-ons both answer 2xx and leave one unit enablement. What
 * does order an act is an activation, which holds the plugin row exclusively
 * while it replaces the manifest: an act ahead of it lands under the old sha,
 * and an act behind it is refused stale.
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
   * Generous on purpose. A request has to clear a session lookup, a policy
   * guard and a manifest revalidation before it reaches the lock, and a cold
   * start takes seconds, so a budget sized for a barrier statement would
   * report a cold start as a lock defect. A request that answers early is
   * reported at once rather than at the deadline, so the long deadline only
   * costs time on a stuck run.
   */
  const REQUEST_REACHES_LOCK_MS = 20_000;

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
   * Fires a request expected to block, and keeps hold of it safely, for two
   * reasons. A promise nobody has handled becomes an unhandled rejection if an
   * assertion throws first, and a request that answers early is a fixture
   * problem, so it is reported as answered, not as a timeout.
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

  const unitRow = (householdId: string, pluginId: string) =>
    db.client.householdPlugin.findFirstOrThrow({ where: { householdId, pluginId } });

  /** `shownRisks` is read before the race starts, so the read never waits behind a held lock (#1336). */
  const approve = (actor: SessionActor, slug: string, shownRisks: readonly ShownRiskBody[]) =>
    request(baseUrl)
      .post(`${PLUGINS_PATH}/${slug}/update/approve`)
      .set(actor.headers)
      .send({ stagingId: INVENTORY_STAGING_ID, shownRisks });

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

  describe('two first switch-ons on one unit', () => {
    it('both answer 2xx and leave one unit enablement, switched on, with every decision naming one of the acts (#1152)', async () => {
      // Two household admins switch the plugin on for a household that has no
      // unit enablement yet. Nothing orders two acts on one unit (#1152), so
      // both read no unit enablement and no decision, and both write. The
      // decisions and the unit enablement are written by upsert, so the later
      // write updates the row the earlier one inserted rather than colliding
      // with it, and both acts stay on record. Whether one act or two is
      // recorded, and which wrote last, are the race's business and never
      // asserted: the later act records nothing when the earlier one committed
      // before it read.
      const owner = await actors.user();
      const second = await actors.user();
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: second, role: 'HouseholdAdmin' }],
      });
      const plugin = await arrangePlugin();
      const unit = { householdId: household.id };
      const surface = await readConsentSurface(baseUrl, owner, unit, plugin.slug);
      const body = switchOnBody(surface, { [HOUSEHOLD_CHECK.slug]: PluginGrantStatus.Granted });

      const [ownerResponse, secondResponse] = await withBarrier(async (barrier) => {
        const { holder } = barrier;

        // The plugin row held as activation holds it, so both switch-ons queue
        // at their claim and are released together. That makes the overlap
        // likely, not certain: each still runs its own statements at its own
        // pace once the row comes free.
        await holder.begin();
        await holder.query('SELECT id FROM plugins WHERE id = $1 FOR UPDATE', [plugin.id]);

        const ownerSwitchOn = fire(() => sendSwitchOn(baseUrl, owner, unit, plugin.slug, body));
        const secondSwitchOn = fire(() => sendSwitchOn(baseUrl, second, unit, plugin.slug, body));

        await expectBackendsQueuedBehind(barrier, {
          heldBy: holder.pid,
          count: 2,
          description: 'the two switch-ons',
          timeoutMs: REQUEST_REACHES_LOCK_MS,
        });

        // Released before anything else is asked of the database: both
        // requests wait inside a Prisma interactive transaction on its default
        // budget, and every question asked while the row is held spends it.
        await holder.commit();

        return Promise.all([ownerSwitchOn.settled, secondSwitchOn.settled]);
      });

      // Asserted as a pair rather than chained, so a 500 reports its status.
      expect([ownerResponse.status, secondResponse.status]).toEqual([200, 200]);

      const units = await db.client.householdPlugin.findMany({
        where: { householdId: household.id, pluginId: plugin.id },
      });

      expect(units).toHaveLength(1);
      expect(units[0]?.enabled).toBe(true);

      const acts = await db.client.pluginConsentAct.findMany({
        where: {
          pluginId: plugin.id,
          scopeType: PluginGrantScope.Household,
          scopeId: household.id,
          kind: PluginConsentActKind.SwitchOn,
        },
      });

      expect(acts.length).toBeGreaterThanOrEqual(1);
      expect(acts.length).toBeLessThanOrEqual(2);

      const decisions = await db.client.pluginGrant.findMany({
        where: { pluginId: plugin.id, scopeType: PluginGrantScope.Household, scopeId: household.id },
      });

      // An empty list would pass the `every` check below for nothing.
      expect(decisions).not.toHaveLength(0);
      expect(decisions.every((decision) => acts.some((act) => act.id === decision.actId))).toBe(true);
    });
  });

  describe('an act against an activation', () => {
    // The act's plugin-row claim compares the sha the consent surface named
    // with the row it locks (#1150). Activation holds that row FOR UPDATE while
    // it replaces the manifest. Both cases hold the row as activation does and
    // queue the two requests behind it one at a time, and Postgres grants a
    // queued row lock in arrival order, so each case has one outcome: the act
    // queued first claims the row first and commits under the old sha, and the
    // act queued after the approval finds the sha moved. What must never happen
    // is an act recorded under a sha the plugin no longer held.

    /** A household with a plugin whose update is staged, and the consent surface its owner reads. */
    const arrangeStagedUpdate = async () => {
      const owner = await actors.user();
      const approver = await actors.admin();
      const { household } = await actors.householdWithMembers({ owner });
      const staged = manifestWith('1.3.0', [MANAGE_DIGEST_CHECK, POLICY_READ_CHECK, HOUSEHOLD_CHECK]);
      const plugin = await arrangePlugin(undefined, stagedUpdateColumns({ manifest: staged, since: STAGED_AT }));
      const unit = { householdId: household.id };
      const surface = await readConsentSurface(baseUrl, owner, unit, plugin.slug);

      expect(surface.manifestSha256).toBe(plugin.installedSha256);

      const sendOldShaSwitchOn = () =>
        sendSwitchOn(
          baseUrl,
          owner,
          unit,
          plugin.slug,
          switchOnBody(surface, { [HOUSEHOLD_CHECK.slug]: PluginGrantStatus.Granted }),
        );

      return { approver, household, plugin, oldSha: surface.manifestSha256, sendOldShaSwitchOn };
    };

    /** The household's acts: the approval records its own, for the Server unit (#1336). */
    const householdActs = (pluginId: string, householdId: string) =>
      db.client.pluginConsentAct.findMany({
        where: { pluginId, scopeType: PluginGrantScope.Household, scopeId: householdId },
      });

    it('an act that reaches the plugin row before an activation lands under the old sha, ahead of the activation (#1152)', async () => {
      const { approver, household, plugin, oldSha, sendOldShaSwitchOn } = await arrangeStagedUpdate();

      const { switchOn, activation } = await withBarrier(async (barrier) => {
        const { holder } = barrier;

        // The act queues first, then the approval behind it.
        const shownRisks = await readStagedShownRisks(baseUrl, approver, plugin.slug);
        await holder.begin();
        await holder.query('SELECT id FROM plugins WHERE id = $1 FOR UPDATE', [plugin.id]);

        const act = fire(sendOldShaSwitchOn);

        await expectLockWaiter(barrier, {
          heldBy: holder.pid,
          description: 'the switch-on naming the old sha',
          timeoutMs: REQUEST_REACHES_LOCK_MS,
          exclude: [barrier.waiter.pid, barrier.observer.pid],
          settledEarly: act.settledEarly,
        });

        const approval = fire(() => approve(approver, plugin.slug, shownRisks));

        await expectBackendsQueuedBehind(barrier, {
          heldBy: holder.pid,
          count: 2,
          description: 'the switch-on naming the old sha and the approval',
          timeoutMs: REQUEST_REACHES_LOCK_MS,
        });

        // Released before anything else is asked of the database: both
        // requests wait inside a Prisma interactive transaction on its default
        // budget, and every question asked while the row is held spends it.
        await holder.commit();

        return { switchOn: await act.settled, activation: await approval.settled };
      });

      expect(switchOn.status).toBe(200);
      expect(activation.status).toBe(200);

      const activated = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });

      expect(activated.installedSha256).not.toBe(oldSha);

      const acts = await householdActs(plugin.id, household.id);

      expect(acts).toHaveLength(1);
      expect(acts[0]?.manifestSha256).toBe(oldSha);
      expect(switchOn.body.act?.id).toBe(acts[0]?.id);
      // Not after the activation's write to the plugin row. Both stamps are the
      // api's clock, taken as each statement is built, so an act whose claim
      // waited behind the activation would carry the later stamp; the two can
      // share a millisecond, so equal is allowed.
      expect(acts[0]?.createdAt.getTime()).toBeLessThanOrEqual(activated.updatedAt.getTime());
    });

    it('an act that reaches the plugin row after an activation is refused stale and records nothing (#1150)', async () => {
      const { approver, household, plugin, oldSha, sendOldShaSwitchOn } = await arrangeStagedUpdate();

      const { switchOn, activation } = await withBarrier(async (barrier) => {
        const { holder } = barrier;

        // The approval queues first, then the act behind it. This is the order
        // that puts the act's claim AFTER the manifest moved, so it is the one
        // that exercises the sha comparison.
        const shownRisks = await readStagedShownRisks(baseUrl, approver, plugin.slug);
        await holder.begin();
        await holder.query('SELECT id FROM plugins WHERE id = $1 FOR UPDATE', [plugin.id]);

        const approval = fire(() => approve(approver, plugin.slug, shownRisks));

        await expectLockWaiter(barrier, {
          heldBy: holder.pid,
          description: 'the approval',
          timeoutMs: REQUEST_REACHES_LOCK_MS,
          exclude: [barrier.waiter.pid, barrier.observer.pid],
          settledEarly: approval.settledEarly,
        });

        const act = fire(sendOldShaSwitchOn);

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
      expect(switchOn.status).toBe(409);
      expect(switchOn.body.code).toBe('PLUGIN_CONSENT_ACT_STALE');
      expect(await householdActs(plugin.id, household.id)).toHaveLength(0);
    });
  });

  describe('an approval against a server toggle', () => {
    it('a toggle on an optional server-scope permission that reaches the plugin row after an approval is refused stale, and the approval grants the permission under its own act (#1336)', async () => {
      // The approval grants every optional server-scope permission the Server
      // unit has not decided. The row is held as activation holds it and the
      // approval is queued ahead of the toggle, and Postgres grants a queued
      // row lock in arrival order, so this case has one outcome: the approval
      // commits first, granting the permission under its own act, and the
      // toggle, whose claim waits behind activation's FOR UPDATE, finds the
      // sha it named moved and is refused. What must never happen is a refusal
      // recorded under a sha the plugin no longer holds. Two admins, for the
      // reason the household case above gives: one session issuing both
      // requests leaves "something above the service serialized them" as a
      // live explanation for a green run.
      const admin = await actors.admin();
      const approver = await actors.admin();
      const staged = manifestWith('1.3.0', [MANAGE_DIGEST_CHECK, POLICY_READ_CHECK, HOUSEHOLD_CHECK]);
      const plugin = await arrangePlugin(undefined, stagedUpdateColumns({ manifest: staged, since: STAGED_AT }));
      const surface = await readConsentSurface(baseUrl, admin, 'server', plugin.slug);
      const activeSha = surface.manifestSha256;

      expect(activeSha).toBe(plugin.installedSha256);

      const { toggle, activation } = await withBarrier(async (barrier) => {
        const { holder } = barrier;

        // Activation's own plugin-row lock mode, held so both requests queue
        // behind it in a known order: the approval first, then the toggle.
        // That is the order that puts the toggle's claim AFTER the manifest
        // moved, so it is the one that exercises the sha comparison; the
        // other order only shows the toggle committing first, which a missing
        // comparison would pass too.
        const shownRisks = await readStagedShownRisks(baseUrl, approver, plugin.slug);
        await holder.begin();
        await holder.query('SELECT id FROM plugins WHERE id = $1 FOR UPDATE', [plugin.id]);

        const approval = fire(() => approve(approver, plugin.slug, shownRisks));

        await expectLockWaiter(barrier, {
          heldBy: holder.pid,
          description: 'the approval',
          timeoutMs: REQUEST_REACHES_LOCK_MS,
          exclude: [barrier.waiter.pid, barrier.observer.pid],
          settledEarly: approval.settledEarly,
        });

        const refusal = fire(() =>
          sendToggle(
            baseUrl,
            admin,
            'server',
            plugin.slug,
            toggleBody(surface, POLICY_READ_CHECK.slug, PluginGrantStatus.Denied),
          ),
        );

        await expectBackendsQueuedBehind(barrier, {
          heldBy: holder.pid,
          count: 2,
          description: 'the approval and the toggle naming the active sha',
          timeoutMs: REQUEST_REACHES_LOCK_MS,
        });

        // Released before anything else is asked of the database: both
        // requests wait inside a Prisma interactive transaction on its default
        // budget, and every question asked while the row is held spends it.
        await holder.commit();

        return { toggle: await refusal.settled, activation: await approval.settled };
      });

      expect(activation.status).toBe(200);

      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });

      expect(row.version).toBe(staged.version);

      const decision = await db.client.pluginGrant.findUniqueOrThrow({
        where: {
          pluginId_scopeType_scopeId_permissionSlug: {
            pluginId: plugin.id,
            scopeType: PluginGrantScope.Server,
            scopeId: '',
            permissionSlug: POLICY_READ_CHECK.slug,
          },
        },
      });
      const acts = await db.client.pluginConsentAct.findMany({ where: { pluginId: plugin.id } });
      const approvalAct = acts.find((act) => act.kind === PluginConsentActKind.UpdateApprove);

      expect(approvalAct?.id).toBe(activation.body.act.id);
      // The toggle found the sha it named no longer installed, so the only act
      // on record is the approval's, and the permission it granted stands.
      expect(toggle.status).toBe(409);
      expect(toggle.body.code).toBe('PLUGIN_CONSENT_ACT_STALE');
      expect(acts).toHaveLength(1);
      expect(decision).toMatchObject({ status: PluginGrantStatus.Granted, actId: approvalAct?.id });
    });
  });
});
