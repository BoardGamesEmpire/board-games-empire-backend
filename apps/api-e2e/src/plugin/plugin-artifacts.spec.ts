import { PluginGrantStatus, RiskLevel } from '@bge/database';
import { createActors, type Actors } from '@bge/testing-e2e';
import type { PluginManifest } from '@boardgamesempire/plugin-manifest';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import { restoreShippedCatalog } from '../permission-catalog/shipped-catalog';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import {
  readConsentSurface,
  sendSwitchOn,
  shownServerRisks,
  switchOnBody,
  unitPluginsPath,
  type ConsentActUnit,
} from './consent-act-fixtures';
import {
  ARTIFACTS_PATH,
  artifactRoutes,
  buildArtifact,
  exists,
  pluginsRoot,
  type BuiltArtifact,
} from './plugin-artifact-fixtures';

/**
 * The install ingress end to end (#1094): a plugin artifact posted by upload,
 * read back, and installed through the real api, with the plugins root the
 * harness gave it. The by-link success path is the receiver's unit test: the
 * outbound HTTP policy the harness runs keeps loopback blocked, so no address
 * a spec controls is reachable, and what the api does with a link it may not
 * fetch is the refusal pinned below.
 */
describe('plugin install ingress (#1094)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const { upload, readBack, install } = artifactRoutes(baseUrl);

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  /** Where the api puts an upload while it arrives: empty once the request has ended. */
  const incoming = (): Promise<string[]> =>
    readdir(join(pluginsRoot(), '.incoming')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return [];
      }

      throw error;
    });

  it('uploads an artifact, reads it back, and installs it (#1094)', async () => {
    const admin = await actors.admin();
    const artifact = await buildArtifact();

    const posted = await upload(admin, artifact).expect(200);

    expect(posted.body.artifact).toMatchObject({ sha256: artifact.sha256, slug: artifact.slug, url: null });
    expect(posted.body.forbiddenImportsToAccept).toEqual([]);
    expect(await db.client.pluginArtifact.findUnique({ where: { sha256: artifact.sha256 } })).not.toBeNull();
    expect(await incoming()).toEqual([]);

    const read = await readBack(admin, artifact.sha256).expect(200);

    expect(read.body).toEqual(posted.body);

    const installed = await install(admin, { sha256: artifact.sha256 }).expect(201);

    expect(installed.body.plugin.slug).toBe(artifact.slug);
    expect(await db.client.pluginArtifact.findUnique({ where: { sha256: artifact.sha256 } })).toBeNull();
    expect(await exists(join(pluginsRoot(), artifact.slug, artifact.sha256))).toBe(true);

    // The one plugin, not the list: the list pages by slug, and earlier specs leave rows behind.
    const inventory = await request(baseUrl).get(`/api/plugins/${artifact.slug}`).set(admin.headers).expect(200);

    expect(inventory.body.plugin).toMatchObject({ slug: artifact.slug, version: '1.2.0' });
    // The row is gone, so the read answers what it does for a checksum nobody posted.
    await readBack(admin, artifact.sha256).expect(404);

    // A retry after a lost response is already at its target: the same answer,
    // with nothing installed again (ADR-0002).
    const replayed = await install(admin, { sha256: artifact.sha256 }).expect(201);

    expect(replayed.body.plugin).toEqual(installed.body.plugin);
  });

  it('an install records one InstallAccept consent act that every server-scope consent decision names (#1336)', async () => {
    const admin = await actors.admin();
    const artifact = await buildArtifact();

    await upload(admin, artifact).expect(200);
    await install(admin, { sha256: artifact.sha256 }).expect(201);

    const plugin = await db.client.plugin.findUniqueOrThrow({ where: { slug: artifact.slug } });
    const acts = await db.client.pluginConsentAct.findMany({ where: { pluginId: plugin.id } });

    expect(acts).toEqual([
      expect.objectContaining({
        pluginSlug: artifact.slug,
        kind: 'InstallAccept',
        scopeType: 'Server',
        manifestVersion: '1.2.0',
        manifestSha256: artifact.sha256,
        decidedById: admin.user.id,
      }),
    ]);

    const decisions = await db.client.pluginGrant.findMany({ where: { pluginId: plugin.id } });

    // The artifact requests `manage:digest` of the server, so there is one to name the act.
    expect(decisions).toHaveLength(1);
    expect(decisions.map((decision) => decision.actId)).toEqual([acts[0]?.id]);

    // A retry installs nothing, so it records no second act (ADR-0002).
    await install(admin, { sha256: artifact.sha256 }).expect(201);

    expect(await db.client.pluginConsentAct.count({ where: { pluginId: plugin.id } })).toBe(1);
  });

  // Installing stamps today's risk on every server-scope permission it grants
  // and records it as shown, so a risk that changed after the read refuses it.
  it('refuses with 409 an install whose read showed a risk the Owner has since changed, and installs nothing (#1336)', async () => {
    const admin = await actors.admin();
    const catalogOwner = await actors.owner();
    // A core permission, so the Owner can change its risk; the declared
    // manage:digest is locked Low.
    const POLICY_READ = 'read:safe_http_policy';
    const artifact = await buildArtifact({
      extraChecks: [
        {
          slug: POLICY_READ,
          required: false,
          reason: { en: 'Inspects the outbound policy before scheduling digest delivery.' },
          consentScope: 'server',
        },
      ],
    });

    const posted = await upload(admin, artifact).expect(200);
    // The one locale the read was rendered in, which the install may send back (#1301).
    expect(posted.body.locale).toBe('en');
    const shownRisks = shownServerRisks(posted.body.checks);
    const shown = shownRisks.find((risk) => risk.permissionSlug === POLICY_READ)?.riskLevel;
    expect(shown).toBeDefined();
    const changed = shown === RiskLevel.Critical ? RiskLevel.High : RiskLevel.Critical;

    try {
      await request(baseUrl)
        .patch(`/api/permission-catalog/permissions/${POLICY_READ}`)
        .set(catalogOwner.headers)
        .send({ riskLevel: changed })
        .expect(200);

      const refused = await install(admin, { sha256: artifact.sha256, shownRisks }).expect(409);

      expect(refused.body).toMatchObject({
        code: 'PLUGIN_CONSENT_ACT_STALE',
        slug: artifact.slug,
        kind: 'risk',
        staleRisks: [{ permissionSlug: POLICY_READ, shownRiskLevel: shown, currentRiskLevel: changed }],
      });
      expect(await db.client.plugin.findUnique({ where: { slug: artifact.slug } })).toBeNull();
      // The artifact waits, so the server admin can read it again and install.
      await readBack(admin, artifact.sha256).expect(200);
    } finally {
      await restoreShippedCatalog(db.client);
    }
  });

  // The e2e server supports `en` alone, so the install names `en` against an
  // `Accept-Language` the server cannot serve; the controller spec proves a
  // named locale beats the request's own (#1301).
  it("an install stores its act's presentation in the locale it names, and refuses one the server doesn't support (#1301)", async () => {
    const admin = await actors.admin();
    const artifact = await buildArtifact();
    const installNaming = (locale: string) =>
      install(admin, { sha256: artifact.sha256, locale }).set('Accept-Language', 'de');

    await upload(admin, artifact).expect(200);

    const refused = await installNaming('xx').expect(422);

    expect(refused.body).toMatchObject({ code: 'PLUGIN_CONSENT_ACT_LOCALE', locale: 'xx' });
    expect(await db.client.plugin.findUnique({ where: { slug: artifact.slug } })).toBeNull();
    expect(await db.client.pluginArtifact.findUnique({ where: { sha256: artifact.sha256 } })).not.toBeNull();

    await installNaming('en').expect(201);

    const plugin = await db.client.plugin.findUniqueOrThrow({ where: { slug: artifact.slug } });
    const [act] = await db.client.pluginConsentAct.findMany({ where: { pluginId: plugin.id } });

    expect(act).toMatchObject({ kind: 'InstallAccept' });
    expect((act?.presentation as { locale?: string }).locale).toBe('en');
  });

  it('a reinstall over an uninstalled plugin records a second InstallAccept act, and its decisions name the second (#1336)', async () => {
    const admin = await actors.admin();
    const artifact = await buildArtifact();

    await upload(admin, artifact).expect(200);
    await install(admin, { sha256: artifact.sha256 }).expect(201);
    await request(baseUrl).post(`/api/plugins/${artifact.slug}/uninstall`).set(admin.headers).send({}).expect(200);

    // A new artifact for the same slug: a reinstall, which keeps the plugin's id.
    const again = await buildArtifact({ slug: artifact.slug, indexJs: 'module.exports = () => ({ again: true });\n' });

    await upload(admin, again).expect(200);
    await install(admin, { sha256: again.sha256 }).expect(201);

    const plugin = await db.client.plugin.findUniqueOrThrow({ where: { slug: artifact.slug } });
    const acts = await db.client.pluginConsentAct.findMany({
      where: { pluginId: plugin.id },
      orderBy: { decidedAt: 'asc' },
    });

    // The append-only record keeps the first install's act through the uninstall.
    expect(acts.map((act) => [act.kind, act.manifestSha256])).toEqual([
      ['InstallAccept', artifact.sha256],
      ['InstallAccept', again.sha256],
    ]);

    const decisions = await db.client.pluginGrant.findMany({ where: { pluginId: plugin.id } });

    expect(decisions).toHaveLength(1);
    expect(decisions.map((decision) => decision.actId)).toEqual([acts[1]?.id]);
  });

  // Uninstall switches every unit enablement off and keeps its configuration,
  // so after a reinstall no unit reads as on for a version nobody switched it
  // on for. Switching on again is a consent act, under the new sha (#1328).
  it('a household switched on before an uninstall reads off after the reinstall, keeps its configuration, and switches on again with a new act under the new sha (#1328)', async () => {
    const admin = await actors.admin();
    const owner = await actors.user();
    const { household } = await actors.householdWithMembers({ owner });
    const householdUnit: ConsentActUnit = { householdId: household.id };
    // Allowlisted public reads, which household and user consent may hold
    // (#591). The household one is required, so each household switch-on
    // answers it; without a user-scope request a user has nothing to switch on.
    const HOUSEHOLD_READ = 'read:game:public';
    const USER_READ = 'read:game_collection:public';
    const checks: PluginManifest['permissions']['checks'] = [
      {
        slug: HOUSEHOLD_READ,
        required: true,
        reason: { en: 'Lists the public games the household digest features.' },
        consentScope: 'household',
      },
      {
        slug: USER_READ,
        required: false,
        reason: { en: 'Shows public collections in each member’s digest.' },
        consentScope: 'user',
      },
    ];
    // Both versions carry the fixture's config schema, which the document
    // fits, so the switch-on after the reinstall is judged on consent alone.
    const config = { webhookUrl: 'https://household.example.test/hook' };
    const artifact = await buildArtifact({ extraChecks: checks, manifest: { scope: 'household' } });
    const slug = artifact.slug;

    const installAndSwitchOnServer = async (built: BuiltArtifact) => {
      await upload(admin, built).expect(200);
      await install(admin, { sha256: built.sha256 }).expect(201);
      await request(baseUrl).post(`/api/plugins/${slug}/enable`).set(admin.headers).send({}).expect(200);
    };

    const switchOn = async (unit: ConsentActUnit, permissionSlug: string, document?: Record<string, unknown>) => {
      const surface = await readConsentSurface(baseUrl, owner, unit, slug);

      return sendSwitchOn(
        baseUrl,
        owner,
        unit,
        slug,
        switchOnBody(surface, { [permissionSlug]: PluginGrantStatus.Granted }, document),
      ).expect(200);
    };

    /** The unit's state as the owner's plugin read reports it: the household's list, or their own. */
    const unitState = async (unit: ConsentActUnit): Promise<string | undefined> => {
      const listed = await request(baseUrl)
        .get(`${unitPluginsPath(unit)}?limit=100`)
        .set(owner.headers)
        .expect(200);

      return listed.body.plugins.find((entry: { slug: string }) => entry.slug === slug)?.unit?.state;
    };

    await installAndSwitchOnServer(artifact);
    await switchOn(householdUnit, HOUSEHOLD_READ, config);
    await switchOn('me', USER_READ);

    expect(await unitState(householdUnit)).toBe('on');
    expect(await unitState('me')).toBe('on');

    await request(baseUrl).post(`/api/plugins/${slug}/uninstall`).set(admin.headers).send({}).expect(200);

    const again = await buildArtifact({
      slug,
      indexJs: 'module.exports = () => ({ again: true });\n',
      extraChecks: checks,
      manifest: { scope: 'household' },
    });

    await installAndSwitchOnServer(again);

    expect(await unitState(householdUnit)).toBe('off');
    expect(await unitState('me')).toBe('off');

    const plugin = await db.client.plugin.findUniqueOrThrow({ where: { slug } });

    expect(
      await db.client.householdPlugin.findUnique({
        where: { householdId_pluginId: { householdId: household.id, pluginId: plugin.id } },
      }),
    ).toMatchObject({ enabled: false, config });

    // No document supplied: the retained one is judged and kept.
    const householdOn = await switchOn(householdUnit, HOUSEHOLD_READ);

    expect(householdOn.body.unit).toMatchObject({ enabled: true, config });

    await switchOn('me', USER_READ);

    expect(await unitState(householdUnit)).toBe('on');
    expect(await unitState('me')).toBe('on');

    const switchOns = await db.client.pluginConsentAct.findMany({
      where: { pluginId: plugin.id, kind: 'SwitchOn', manifestSha256: again.sha256 },
    });

    expect(switchOns.map((act) => act.scopeType).sort()).toEqual(['Household', 'User']);
    expect(switchOns.every((act) => act.decidedById === owner.user.id)).toBe(true);
  });

  it('a checksum mismatch by upload keeps nothing (#1094)', async () => {
    const admin = await actors.admin();
    const artifact = await buildArtifact();

    const refused = await upload(admin, artifact, 'f'.repeat(64)).expect(422);

    expect(refused.body.code).toBe('PLUGIN_ARTIFACT_CHECKSUM_MISMATCH');
    expect(await exists(join(pluginsRoot(), artifact.slug))).toBe(false);
    expect(await db.client.pluginArtifact.count({ where: { slug: artifact.slug } })).toBe(0);
    expect(await incoming()).toEqual([]);
  });

  it('a raw DatabaseService import must be accepted per specifier (#1094)', async () => {
    const admin = await actors.admin();
    const artifact = await buildArtifact({
      indexJs: "const { DatabaseService } = require('@bge/database');\nmodule.exports = DatabaseService;\n",
    });

    const posted = await upload(admin, artifact).expect(200);

    expect(posted.body.forbiddenImportsToAccept).toEqual(['@bge/database']);

    const challenged = await install(admin, { sha256: artifact.sha256 }).expect(409);

    expect(challenged.body.code).toBe('PLUGIN_INSTALL_STATIC_ANALYSIS');
    // The challenge keeps the artifact waiting, so the server admin can answer it.
    await readBack(admin, artifact.sha256).expect(200);

    const installed = await install(admin, {
      sha256: artifact.sha256,
      acknowledgeForbiddenImports: ['@bge/database'],
    }).expect(201);

    expect(installed.body.plugin.slug).toBe(artifact.slug);
  });

  it('a link to a loopback address is refused (#1094)', async () => {
    const admin = await actors.admin();

    const refused = await request(baseUrl)
      .post(ARTIFACTS_PATH)
      .set(admin.headers)
      .send({ url: 'http://127.0.0.1:9/plugin.tgz', sha256: 'a'.repeat(64) })
      .expect(422);

    expect(refused.body.code).toBe('PLUGIN_ARTIFACT_LINK_REFUSED');
    expect(refused.body.reason).toBe('blocked-by-policy');
  });

  it('each route refuses an actor without manage Plugin (#1094)', async () => {
    const user = await actors.user();
    const artifact = await buildArtifact();

    await upload(user, artifact).expect(403);
    await readBack(user, artifact.sha256).expect(403);
    await install(user, { sha256: artifact.sha256 }).expect(403);
    expect(await db.client.pluginArtifact.count({ where: { slug: artifact.slug } })).toBe(0);
  });

  it('installing an artifact past its expiry answers not found (#1094)', async () => {
    const admin = await actors.admin();
    const artifact = await buildArtifact();

    await upload(admin, artifact).expect(200);
    await db.client.pluginArtifact.update({
      where: { sha256: artifact.sha256 },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const refused = await install(admin, { sha256: artifact.sha256 }).expect(404);

    expect(refused.body.code).toBe('PLUGIN_ARTIFACT_NOT_FOUND');
  });
});
