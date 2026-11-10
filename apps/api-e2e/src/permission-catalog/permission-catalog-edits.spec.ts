import {
  PERMISSION_CATALOG,
  PermissionOwner,
  PluginGrantScope,
  PluginGrantStatus,
  PluginScope,
  Reach,
  RiskLevel,
  SystemRole,
  type Plugin,
} from '@bge/database';
import { PermissionsService } from '@bge/permissions';
import { createActors, type Actors, type AuthenticatedActor, type SessionActor } from '@bge/testing-e2e';
import { buildPluginManifest, type PluginManifest } from '@boardgamesempire/plugin-manifest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { pluginRowData } from '../plugin/plugin-row-fixtures';
import { permissionsCacheHas } from '../support/api-cache';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { flushPermissionGraphs, reconcileAsAtStart, restoreShippedCatalog } from './shipped-catalog';

/**
 * The Owner's edits of the permission catalog, end to end (#772): through the
 * routes, the entry check's probe on the api's own client, Postgres, and the
 * cached permission graphs in Valkey.
 *
 * A start is the in-process reconcile `reconcileAsAtStart` runs, with the
 * flush the api's bootstrap runs after a reconcile that wrote rows; the
 * harness cannot restart the api mid-run.
 *
 * The permission catalog's tables outlive the between-test sweep, so
 * `afterEach` hands every entry back and reconciles, and fails the test
 * unless the permission catalog is the shipped one again.
 */

/** A permission's row as `GET /permission-catalog` answers it. */
interface CatalogPermissionWire {
  readonly slug: string;
  readonly conditions: unknown;
  readonly reason: string | null;
  readonly riskLevel: RiskLevel;
  readonly managedBy: PermissionOwner;
  readonly retiredAt: string | null;
  readonly shipped: boolean;
  readonly drift: readonly { readonly field: string; readonly from: unknown; readonly to: unknown }[];
}

/** A role's grant as `GET /permission-catalog` answers it. */
interface CatalogGrantWire {
  readonly slug: string;
  readonly managedBy: PermissionOwner;
  readonly revokedAt: string | null;
  readonly shipped: boolean;
}

interface CatalogWire {
  readonly permissions: readonly CatalogPermissionWire[];
  readonly roles: readonly { readonly name: string; readonly grants: readonly CatalogGrantWire[] }[];
}

/** The permission as this version ships it. */
function shipped(slug: string) {
  const definition = PERMISSION_CATALOG.find((permission) => permission.slug === slug);
  if (definition === undefined) {
    throw new Error(`The permission catalog ships no permission '${slug}'`);
  }

  return definition;
}

const SHIPPED_REASON = shipped('read:game').reason;
const EDITED_REASON = 'The games you made yourself, whoever else they reach';

describe('the Owner edits the permission catalog (#772)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const PATH = '/api/permission-catalog';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterEach(async () => {
    await restoreShippedCatalog(db.client);
  });

  afterAll(async () => {
    await db.close();
  });

  const editPermission = (owner: SessionActor, slug: string, body: Record<string, unknown>) =>
    request(baseUrl).patch(`${PATH}/permissions/${slug}`).set(owner.headers).send(body);

  const revokeGrant = (owner: SessionActor, role: string, slug: string) =>
    request(baseUrl).delete(`${PATH}/roles/${role}/grants/${slug}`).set(owner.headers);

  async function readCatalog(owner: SessionActor): Promise<CatalogWire> {
    return (await request(baseUrl).get(PATH).set(owner.headers).expect(200)).body;
  }

  function permissionIn(catalog: CatalogWire, slug: string): CatalogPermissionWire {
    const permission = catalog.permissions.find((entry) => entry.slug === slug);
    if (permission === undefined) {
      throw new Error(`GET ${PATH} answered no permission '${slug}'`);
    }

    return permission;
  }

  function grantIn(catalog: CatalogWire, role: string, slug: string): CatalogGrantWire | undefined {
    return catalog.roles.find((entry) => entry.name === role)?.grants.find((grant) => grant.slug === slug);
  }

  const readGame = (actor: AuthenticatedActor, id: string) =>
    request(baseUrl).get(`/api/games/${id}`).set(actor.headers);

  const arrangeGame = (createdById: string, reach: Reach) =>
    db.client.game.create({
      data: { title: `e2e game ${randomUUID().slice(0, 8)}`, reach, createdById },
      select: { id: true },
    });

  /**
   * A reader, and a game that only `User`'s `read:game` lets them read: a
   * Private game they created, with no friend and no share. Of `User`'s other
   * reads of games, `read:game:public` wants a Public game, the three
   * friends' reads a game of a friend's that reaches that far, and
   * `read:game:shared` a share. The reader's own Public game is the control:
   * `read:game:public` reads it whatever happens to `read:game`, so a denial
   * of the Private one is about the grant, not the route.
   */
  async function arrangeReader() {
    const [owner, reader] = await Promise.all([actors.owner(), actors.user()]);
    const [privateGame, publicGame] = await Promise.all([
      arrangeGame(reader.user.id, Reach.Private),
      arrangeGame(reader.user.id, Reach.Public),
    ]);

    return { owner, reader, privateGame, publicGame };
  }

  it('an edit survives the next start, and reports drift', async () => {
    const owner = await actors.owner();
    const drift = [{ field: 'reason', from: EDITED_REASON, to: SHIPPED_REASON }];

    const edited = await editPermission(owner, 'read:game', { reason: EDITED_REASON }).expect(200);

    expect(edited.body).toEqual({
      permission: expect.objectContaining({
        slug: 'read:game',
        reason: EDITED_REASON,
        managedBy: PermissionOwner.Admin,
        retiredAt: null,
        drift,
      }),
      warnings: [],
      consentDecisionsAffected: 0,
    });

    const restarted = await reconcileAsAtStart(db.client);

    expect(restarted.mutations).toBe(0);
    expect(restarted.plan.permissions.skipped).toEqual([
      { slug: 'read:game', managedBy: PermissionOwner.Admin, drift },
    ]);
    expect(permissionIn(await readCatalog(owner), 'read:game')).toMatchObject({
      conditions: shipped('read:game').conditions,
      reason: EDITED_REASON,
      managedBy: PermissionOwner.Admin,
      retiredAt: null,
      drift,
    });
  });

  it('a revoked shipped grant stops conferring at once and stays revoked after the next start', async () => {
    const { owner, reader, privateGame, publicGame } = await arrangeReader();

    await readGame(reader, privateGame.id).expect(200);
    await readGame(reader, publicGame.id).expect(200);
    // The reader's permission graph is cached, so only the revoke's flush can
    // make the next read see the revoked grant.
    expect(await permissionsCacheHas(PermissionsService.userGraphCacheKey(reader.user.id))).toBe(true);

    const revoked = await revokeGrant(owner, SystemRole.User, 'read:game').expect(200);

    expect(revoked.body).toEqual({
      grant: { slug: 'read:game', managedBy: PermissionOwner.Admin, revokedAt: expect.any(String), shipped: true },
      warnings: [],
    });
    expect(await permissionsCacheHas(PermissionsService.userGraphCacheKey(reader.user.id))).toBe(false);

    await readGame(reader, privateGame.id).expect(403);
    await readGame(reader, publicGame.id).expect(200);

    const restarted = await reconcileAsAtStart(db.client);

    expect(restarted.mutations).toBe(0);
    expect(restarted.plan.rolePermissions.skipped).toEqual([
      { roleName: SystemRole.User, permissionSlug: 'read:game' },
    ]);
    expect(grantIn(await readCatalog(owner), SystemRole.User, 'read:game')).toEqual(revoked.body.grant);

    // A start that writes nothing flushes nothing, so the graph the denial
    // above cached would deny either way. Flushed, the next read loads the
    // grant from the database.
    await flushPermissionGraphs();
    await readGame(reader, privateGame.id).expect(403);
    await readGame(reader, publicGame.id).expect(200);
  });

  it('handing it back restores it at the next start', async () => {
    const { owner, reader, privateGame } = await arrangeReader();
    const reasonDrift = [{ field: 'reason', from: EDITED_REASON, to: SHIPPED_REASON }];

    await revokeGrant(owner, SystemRole.User, 'read:game').expect(200);
    await editPermission(owner, 'read:game', { reason: EDITED_REASON }).expect(200);
    await readGame(reader, privateGame.id).expect(403);

    const grantBack = await request(baseUrl)
      .post(`${PATH}/roles/${SystemRole.User}/grants/read:game/hand-back`)
      .set(owner.headers)
      .expect(200);
    const permissionBack = await request(baseUrl)
      .post(`${PATH}/permissions/read:game/hand-back`)
      .set(owner.headers)
      .expect(200);

    expect(grantBack.body).toEqual({ nextStart: 'grant-restored' });
    expect(permissionBack.body).toEqual({ nextStart: reasonDrift });

    // A hand-back only marks the entry the server's: until the next start the
    // grant stays revoked and the reason edited. An entry the server
    // maintains reports no drift; `nextStart` said what the start will do.
    const handedBack = await readCatalog(owner);
    expect(grantIn(handedBack, SystemRole.User, 'read:game')).toEqual({
      slug: 'read:game',
      managedBy: PermissionOwner.System,
      revokedAt: expect.any(String),
      shipped: true,
    });
    expect(permissionIn(handedBack, 'read:game')).toMatchObject({
      reason: EDITED_REASON,
      managedBy: PermissionOwner.System,
      drift: [],
    });
    // Flushed, so the read loads the grant from the database rather than the
    // graph the denial above cached: revoked, it confers nothing, whoever
    // manages it.
    await flushPermissionGraphs();
    await readGame(reader, privateGame.id).expect(403);

    const restarted = await reconcileAsAtStart(db.client);

    expect(restarted.plan.rolePermissions.restore).toEqual([
      { roleName: SystemRole.User, permissionSlug: 'read:game' },
    ]);
    expect(restarted.plan.permissions.update).toEqual([{ slug: 'read:game', changes: reasonDrift }]);
    expect(restarted.invalidated).toBe(true);

    const started = await readCatalog(owner);
    expect(grantIn(started, SystemRole.User, 'read:game')).toEqual({
      slug: 'read:game',
      managedBy: PermissionOwner.System,
      revokedAt: null,
      shipped: true,
    });
    expect(permissionIn(started, 'read:game')).toMatchObject({
      reason: SHIPPED_REASON,
      managedBy: PermissionOwner.System,
      drift: [],
    });
    await readGame(reader, privateGame.id).expect(200);
  });

  it('refuses visibility on Game with CATALOG_ENTRY_REFUSED and a query-rejected problem', async () => {
    // The column #808 renamed to `reach`: Prisma refuses the condition, so
    // the probe in the edit's transaction does, and nothing is written.
    const owner = await actors.owner();

    const refused = await editPermission(owner, 'read:game', { conditions: { visibility: 'Public' } }).expect(422);

    expect(refused.body).toMatchObject({
      code: 'CATALOG_ENTRY_REFUSED',
      message: expect.stringMatching(/wasn't saved/),
    });
    expect(refused.body.problems).toContainEqual({
      kind: 'query-rejected',
      slug: 'read:game',
      message: expect.stringContaining('Unknown argument `visibility`'),
    });
    expect(permissionIn(await readCatalog(owner), 'read:game')).toMatchObject({
      conditions: shipped('read:game').conditions,
      managedBy: PermissionOwner.System,
      drift: [],
    });
  });

  describe('a consent decision in force', () => {
    type Check = PluginManifest['permissions']['checks'][number];

    /** The plugin's own declared permission, as `plugin-grant-consent.spec.ts` declares it. */
    const MANAGE_DIGEST_CHECK: Check = {
      slug: 'manage:digest',
      required: true,
      reason: { en: 'Stores and manages the digest configuration it owns.' },
      consentScope: 'server',
    };

    /**
     * An allowlisted public read, which a household may consent to (#591).
     * Low as shipped. Bound to the fixture manifest's feature, so the
     * household's feature state says whether its decision confers.
     */
    const HOUSEHOLD_CHECK: Check = {
      slug: 'read:game:public',
      required: true,
      reason: { en: 'Lists the public games the household digest features.' },
      consentScope: 'household',
      feature: 'weekly-digest',
    };

    /**
     * An installed, enabled plugin whose active manifest requests
     * `read:game:public` at household scope, and the `PluginPermission` row
     * the install pipeline creates for its declared permission, which
     * deciding needs. Arranged on the rows, as the consent specs arrange it.
     */
    async function arrangePlugin(): Promise<Plugin> {
      const active = buildPluginManifest({
        version: '1.2.0',
        scope: 'household',
        bgeCompat: '>=0.0.0',
        permissions: { checks: [MANAGE_DIGEST_CHECK, HOUSEHOLD_CHECK] },
      });

      const plugin = await db.client.plugin.create({
        data: pluginRowData({
          slug: active.slug,
          version: active.version,
          scope: PluginScope.Household,
          manifestJson: active as never,
          enabled: true,
        }),
      });
      await db.client.pluginPermission.create({
        data: { pluginId: plugin.id, slug: `plugin|${plugin.slug}|manage:digest`, riskLevel: RiskLevel.Low },
      });

      return plugin;
    }

    const grantForHousehold = (householdOwner: SessionActor, householdId: string, plugin: Plugin) =>
      request(baseUrl)
        .post(`/api/households/${householdId}/plugins/${plugin.slug}/grants`)
        .set(householdOwner.headers)
        .send({ permissionSlug: 'read:game:public', status: PluginGrantStatus.Granted });

    /** The household's state of the feature its decision on `read:game:public` gates. */
    async function readDigest(householdOwner: SessionActor, householdId: string, plugin: Plugin) {
      const { body } = await request(baseUrl)
        .get(`/api/households/${householdId}/plugins/${plugin.slug}/features`)
        .set(householdOwner.headers)
        .expect(200);

      return body.featureState.features.find((feature: { name: string }) => feature.name === 'weekly-digest');
    }

    it('raising a risk level reports the consent decisions it affects, and the one in force stops conferring', async () => {
      const [owner, servedOwner, unservedOwner] = await Promise.all([actors.owner(), actors.user(), actors.user()]);
      // Both households are arranged before either owner's first request, so
      // each owner's cached graph holds their household role.
      const served = await actors.householdWithMembers({ owner: servedOwner });
      const unserved = await actors.householdWithMembers({ owner: unservedOwner });
      const plugin = await arrangePlugin();

      // The served household has the plugin switched on; the unserved one
      // never switched it on, so its decision confers nothing and is not in
      // force, though it is granted all the same.
      await db.client.householdPlugin.create({
        data: { householdId: served.household.id, pluginId: plugin.id, enabled: true },
      });
      await grantForHousehold(servedOwner, served.household.id, plugin).expect(200);
      await grantForHousehold(unservedOwner, unserved.household.id, plugin).expect(200);

      const decisions = await db.client.pluginGrant.findMany({
        where: { pluginId: plugin.id },
        select: { scopeType: true, scopeId: true, status: true, decidedRiskLevel: true },
      });
      expect(decisions).toHaveLength(2);
      expect(decisions).toEqual(
        expect.arrayContaining(
          [served, unserved].map(({ household }) => ({
            scopeType: PluginGrantScope.Household,
            scopeId: household.id,
            status: PluginGrantStatus.Granted,
            decidedRiskLevel: RiskLevel.Low,
          })),
        ),
      );

      // In force: the served household's decision confers, so the feature it
      // gates runs there.
      expect(await readDigest(servedOwner, served.household.id, plugin)).toMatchObject({
        state: 'active',
        blockingSlugs: [],
      });

      const raised = await editPermission(owner, 'read:game:public', { riskLevel: RiskLevel.Medium }).expect(200);

      // One, not two: the decision made at Low no longer covers Medium, and
      // only the served household's is in force.
      expect(raised.body).toEqual({
        permission: expect.objectContaining({
          slug: 'read:game:public',
          riskLevel: RiskLevel.Medium,
          managedBy: PermissionOwner.Admin,
          drift: [{ field: 'riskLevel', from: RiskLevel.Medium, to: RiskLevel.Low }],
        }),
        warnings: [],
        consentDecisionsAffected: 1,
      });

      // The edit is not refused for it: the decision is judged again against
      // the permission as it now stands, and confers nothing until the
      // household consents at the new risk. The feature state reads the
      // decision as the plugin's resolution does, risk coverage included.
      expect(await readDigest(servedOwner, served.household.id, plugin)).toMatchObject({
        state: 'disabled',
        reason: 'pending',
        blockingSlugs: ['read:game:public'],
      });
    });
  });

  // Postgres refuses a NUL in a query's text, which surfaced as a bare 500;
  // no entry can be named so, so it is answered as an unknown name is.
  it('answers a slug or a role name holding NUL with 404 CATALOG_ENTRY_NOT_FOUND', async () => {
    const owner = await actors.owner();

    const slug = await editPermission(owner, 'read:game%00', { reason: EDITED_REASON }).expect(404);
    const name = await revokeGrant(owner, `${SystemRole.User}%00`, 'read:game').expect(404);

    expect(slug.body).toMatchObject({ code: 'CATALOG_ENTRY_NOT_FOUND' });
    expect(name.body).toMatchObject({ code: 'CATALOG_ENTRY_NOT_FOUND' });
  });

  it('refuses to take full control from the Owner with CATALOG_OWNER_LOCKOUT, and the Owner still reads the permission catalog', async () => {
    const owner = await actors.owner();

    const retired = await editPermission(owner, 'manage:all', { retired: true }).expect(422);
    const revoked = await revokeGrant(owner, SystemRole.Owner, 'manage:all').expect(422);

    for (const refused of [retired, revoked]) {
      expect(refused.body).toMatchObject({
        code: 'CATALOG_OWNER_LOCKOUT',
        message: expect.stringMatching(/full control of the server/),
      });
    }

    const catalog = await readCatalog(owner);
    expect(permissionIn(catalog, 'manage:all')).toMatchObject({ managedBy: PermissionOwner.System, retiredAt: null });
    expect(grantIn(catalog, SystemRole.Owner, 'manage:all')).toEqual({
      slug: 'manage:all',
      managedBy: PermissionOwner.System,
      revokedAt: null,
      shipped: true,
    });
  });
});
