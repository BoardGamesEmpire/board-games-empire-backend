import {
  PluginCategory,
  PluginGrantScope,
  PluginGrantStatus,
  PluginScope,
  RiskLevel,
  type Plugin,
} from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { buildPluginManifest, type PluginManifest } from '@boardgamesempire/plugin-manifest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { MANAGE_DIGEST_CHECK, type Check } from './manifest-checks';

/**
 * The invariants, raced over HTTP (#360 tier 1).
 *
 * These are the cheap ones, and they exercise the real code end to end rather
 * than a replay of its statements: two requests at once, then an assertion
 * about the state they left behind. Both invariants below were found VIOLATED
 * during PR #359's review rounds — first by an unlocked read/write pair, then
 * by a suspend pass that asked only whether the outstanding set was non-empty —
 * and neither was caught by a test, because no test at this tier existed.
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
 * tier is redundant.
 */
describe('consent decisions under concurrency (#360)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const PLUGINS_PATH = '/api/plugins';
  const STAGED_AT = new Date('2026-08-01T12:00:00Z');

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

  /** REQUIRED at household scope: denying it must suspend the unit. */
  const HOUSEHOLD_CHECK: Check = {
    slug: 'read:household_member',
    required: true,
    reason: { en: 'Addresses the digest to the household roster.' },
    consentScope: 'household',
  };

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
      data: {
        slug: active.slug,
        version: active.version,
        category: PluginCategory.FeedbackSink,
        scope: PluginScope.Household,
        manifestJson: active as never,
        enabled: true,
        bundled: false,
        installedSha256: randomUUID(),
        ...overrides,
      },
    });
    await db.client.pluginPermission.create({
      data: { pluginId: plugin.id, slug: `plugin|${plugin.slug}|manage:digest`, riskLevel: RiskLevel.Low },
    });

    return plugin;
  };

  const decideHousehold = (actor: SessionActor, householdId: string, slug: string, body: Record<string, unknown>) =>
    request(baseUrl).post(`/api/households/${householdId}/plugins/${slug}/grants`).set(actor.headers).send(body);

  const decideServer = (actor: SessionActor, slug: string, body: Record<string, unknown>) =>
    request(baseUrl).post(`${PLUGINS_PATH}/${slug}/grants`).set(actor.headers).send(body);

  const approve = (actor: SessionActor, slug: string) =>
    request(baseUrl).post(`${PLUGINS_PATH}/${slug}/update/approve`).set(actor.headers).send({});

  describe('Granted against Denied on the same required household check', () => {
    it('never leaves the unit serving over a durable denial, or suspended with nothing outstanding', async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin();

      await request(baseUrl)
        .post(`/api/households/${household.id}/plugins/${plugin.slug}/enable`)
        .set(owner.headers)
        .send({})
        .expect(200);

      const [first, second] = await Promise.all([
        decideHousehold(owner, household.id, plugin.slug, {
          permissionSlug: HOUSEHOLD_CHECK.slug,
          status: PluginGrantStatus.Granted,
        }),
        decideHousehold(owner, household.id, plugin.slug, {
          permissionSlug: HOUSEHOLD_CHECK.slug,
          status: PluginGrantStatus.Denied,
        }),
      ]);

      // Both decisions are legal at household scope — the required-denial rule
      // refuses a required denial only at SERVER scope — so neither is allowed
      // to fail. Asserted as a pair rather than chained, so a 500 reports its
      // status.
      expect([first.status, second.status]).toEqual([200, 200]);

      const grant = await db.client.pluginGrant.findFirstOrThrow({
        where: {
          pluginId: plugin.id,
          scopeType: PluginGrantScope.Household,
          scopeId: household.id,
          permissionSlug: HOUSEHOLD_CHECK.slug,
        },
      });
      const unit = await db.client.householdPlugin.findFirstOrThrow({
        where: { householdId: household.id, pluginId: plugin.id },
      });

      // THE invariant, both halves. Which decision won is the race's business;
      // that the mirror agrees with it is not.
      expect(unit.suspendedForConsent).toBe(grant.status === PluginGrantStatus.Denied);

      // One row, not two: the upsert is what makes the loser update rather than
      // collide, and a P2002 here would have surfaced as a 500 above.
      expect(await db.client.pluginGrant.count({ where: { pluginId: plugin.id } })).toBe(1);
    });

    it('holds the same invariant when the decisions come from different members', async () => {
      // The single-actor case shares a session, so both requests could in
      // principle be serialized somewhere above the service. Two admins of the
      // same household remove that explanation.
      const owner = await actors.user();
      const second = await actors.user();
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: second, role: 'HouseholdAdmin' }],
      });
      const plugin = await arrangePlugin();

      await request(baseUrl)
        .post(`/api/households/${household.id}/plugins/${plugin.slug}/enable`)
        .set(owner.headers)
        .send({})
        .expect(200);

      const [granted, denied] = await Promise.all([
        decideHousehold(owner, household.id, plugin.slug, {
          permissionSlug: HOUSEHOLD_CHECK.slug,
          status: PluginGrantStatus.Granted,
        }),
        decideHousehold(second, household.id, plugin.slug, {
          permissionSlug: HOUSEHOLD_CHECK.slug,
          status: PluginGrantStatus.Denied,
        }),
      ]);

      expect([granted.status, denied.status]).toEqual([200, 200]);

      const grant = await db.client.pluginGrant.findFirstOrThrow({
        where: { pluginId: plugin.id, scopeId: household.id, permissionSlug: HOUSEHOLD_CHECK.slug },
      });
      const unit = await db.client.householdPlugin.findFirstOrThrow({
        where: { householdId: household.id, pluginId: plugin.id },
      });

      expect(unit.suspendedForConsent).toBe(grant.status === PluginGrantStatus.Denied);
    });
  });

  describe('an approval against a server-scope denial', () => {
    it('never activates a manifest over a denial that is already durable', async () => {
      // The pair #356's lock exists for. The active manifest has the policy
      // read OPTIONAL and the pending one requires it, so the denial is legal
      // right up until the approval commits — and illegal under the
      // required-denial rule immediately after. Exactly one of them can win.
      // Two admins, for the reason the household case above gives: one session
      // issuing both requests leaves "something above the service serialized
      // them" as a live explanation for a green run, and this case is the one
      // 356's row lock exists for.
      const admin = await actors.admin();
      const approver = await actors.admin();
      const pending = manifestWith('1.3.0', [
        MANAGE_DIGEST_CHECK,
        { ...POLICY_READ_CHECK, required: true },
        HOUSEHOLD_CHECK,
      ]);
      const plugin = await arrangePlugin(undefined, {
        pendingVersion: pending.version,
        pendingManifestJson: pending as never,
        pendingSha256: 'e2e-new-sha',
        pendingSince: STAGED_AT,
      });

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
      const activated = row.version === pending.version;

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
      // typed body the client renders its next step from.
      const refusal = activation.status === 409 ? activation : denial;

      expect(refusal.body.code).toBe(
        activation.status === 409 ? 'PluginUpdateBlockedByDenialError' : 'PluginGrantRequiredDenialError',
      );

      if (!activated) {
        expect(row.pendingVersion).toBe(pending.version);
      }
    });
  });
});
