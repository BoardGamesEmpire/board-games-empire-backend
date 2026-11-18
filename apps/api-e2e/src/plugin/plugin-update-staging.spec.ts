import type { Plugin } from '@bge/database';
import { AuthType, PluginLifecycleEventType, ResourceType } from '@bge/database';
import type { Actors, SessionActor } from '@bge/testing-e2e';
import { createActors, pollUntil } from '@bge/testing-e2e';
import type { PluginManifest, PluginManifestOverrides } from '@boardgamesempire/plugin-manifest';
import { join } from 'node:path';
import request from 'supertest';
import { mintApiKey } from '../support/api-key';
import { deferredRequest } from '../support/deferred-request';
import { requireBaseUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import { readStagedShownRisks } from './consent-act-fixtures';
import type { BuiltArtifact } from './plugin-artifact-fixtures';
import { artifactRoutes, buildArtifact, exists, freshPluginSlug, pluginsRoot } from './plugin-artifact-fixtures';

/**
 * Staging an update through the real routes (#1096): version 1.2.0 of a
 * plugin is posted as a plugin artifact and installed, the next version is
 * posted, and `POST /api/plugins/:slug/update/stage` stages it by its
 * checksum. An update with nothing for the server admin to approve is
 * activated at once; one that adds a server-consented permission waits for
 * the update approval, which the update routes answer as before.
 *
 * Every artifact here is an upload. The outbound HTTP policy the harness runs
 * keeps loopback blocked, so a link a spec controls is refused before
 * anything is fetched; the receiver's unit test covers the link.
 */
describe('staging a plugin update from a plugin artifact (#1096)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const PLUGINS_PATH = '/api/plugins';
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

  type Check = PluginManifest['permissions']['checks'][number];

  /** The plugin's own declared permission, as the artifact fixture requests it: origin `plugin`, locked Low. */
  const MANAGE_DIGEST_CHECK: Check = {
    slug: 'manage:digest',
    required: true,
    reason: { en: 'Stores and manages the digest configuration it owns.' },
    consentScope: 'server',
  };

  /**
   * A seeded core permission (Medium) the server consents to, so requesting
   * it anew server-gates the update. `permissions` is a preserved table the
   * between-test sweep never truncates, so tests reference seeded rows only.
   */
  const NEW_SERVER_CHECK: Check = {
    slug: 'read:safe_http_policy',
    required: false,
    reason: { en: 'Inspects the outbound policy before scheduling digest delivery.' },
    consentScope: 'server',
  };

  /** What a next version adds to wait for the update approval. */
  const WAITS_FOR_APPROVAL: PluginManifestOverrides = {
    permissions: { declares: ['manage:digest'], checks: [MANAGE_DIGEST_CHECK, NEW_SERVER_CHECK] },
  };

  const INTO_DATA_GATEWAY: PluginManifestOverrides = { category: 'data-gateway' };

  /** One version of a plugin. Every version of a slug carries the same display name. */
  const versionOf = (slug: string, version: string, manifest: PluginManifestOverrides = {}) =>
    buildArtifact({ slug, manifest: { displayName: { en: `Staged ${slug}` }, ...manifest, version } });

  /** Version 1.2.0 of a fresh plugin, posted and installed through the artifact routes. */
  const installFirstVersion = async (admin: SessionActor): Promise<BuiltArtifact> => {
    const first = await versionOf(freshPluginSlug('staging'), '1.2.0');

    await upload(admin, first).expect(200);
    await install(admin, { sha256: first.sha256 }).expect(201);

    return first;
  };

  /** Version 1.3.0 of the plugin, built but not posted. */
  const nextVersion = (first: BuiltArtifact, manifest: PluginManifestOverrides = {}) =>
    versionOf(first.slug, '1.3.0', manifest);

  const stage = (actor: SessionActor, slug: string, body: Record<string, unknown>) =>
    request(baseUrl).post(`${PLUGINS_PATH}/${slug}/update/stage`).set(actor.headers).send(body);

  /** Sends the risks the staged-update read shows, as a client would (#1336). */
  const approve = (actor: SessionActor, slug: string, stagingId: string) =>
    deferredRequest(
      () => readStagedShownRisks(baseUrl, actor, slug),
      (shownRisks) =>
        request(baseUrl)
          .post(`${PLUGINS_PATH}/${slug}/update/approve`)
          .set(actor.headers)
          .send({ stagingId, shownRisks }),
    );

  const reject = (actor: SessionActor, slug: string, stagingId: string) =>
    request(baseUrl).post(`${PLUGINS_PATH}/${slug}/update/reject`).set(actor.headers).send({ stagingId });

  const readStaged = (actor: SessionActor, slug: string) =>
    request(baseUrl).get(`${PLUGINS_PATH}/${slug}/update/pending`).set(actor.headers);

  const uninstall = (actor: SessionActor, slug: string) =>
    request(baseUrl).post(`${PLUGINS_PATH}/${slug}/uninstall`).set(actor.headers).send({});

  const pluginRow = (slug: string) => db.client.plugin.findUniqueOrThrow({ where: { slug } });

  const artifactRow = (sha256: string) => db.client.pluginArtifact.findUnique({ where: { sha256 } });

  /** The seven columns of a staged update, read straight from the plugin's row. */
  const stagedColumnsOf = (row: Plugin) => ({
    pendingVersion: row.pendingVersion,
    pendingManifestJson: row.pendingManifestJson,
    pendingSha256: row.pendingSha256,
    pendingSince: row.pendingSince,
    pendingStagingId: row.pendingStagingId,
    pendingFromUrl: row.pendingFromUrl,
    pendingRegistrySlug: row.pendingRegistrySlug,
  });

  const NOTHING_STAGED = {
    pendingVersion: null,
    pendingManifestJson: null,
    pendingSha256: null,
    pendingSince: null,
    pendingStagingId: null,
    pendingFromUrl: null,
    pendingRegistrySlug: null,
  };

  /**
   * The plugin's lifecycle rows of one kind, once the listener has had its
   * chance to write what the requests so far emitted. The listener writes
   * each row after the response, so the first row of the kind is awaited,
   * then the server admin switches the plugin on as a marker and its row is
   * awaited too: a second row of the kind would have been emitted, and its
   * insert started, before the marker's. Started is not finished: the
   * listener writes each row on its own, with nothing ordering the commits,
   * so a duplicate whose insert is still running when the marker's commits
   * goes uncounted. A miss can only let a count pass that should fail, never
   * fail one that should pass, so this catches a duplicate in practice
   * without proving there is none.
   */
  const settledLifecycleRows = async (actor: SessionActor, slug: string, event: PluginLifecycleEventType) => {
    const { id: pluginId } = await pluginRow(slug);
    const rowsOf = (kind: PluginLifecycleEventType) =>
      pollUntil(
        async () => {
          const found = await db.client.pluginLifecycleEvent.findMany({ where: { pluginId, event: kind } });

          return found.length > 0 ? found : undefined;
        },
        { description: `the ${kind} lifecycle row for '${slug}'`, timeoutMs: 5_000 },
      );

    await rowsOf(event);
    await request(baseUrl).post(`${PLUGINS_PATH}/${slug}/enable`).set(actor.headers).send({}).expect(200);
    await rowsOf(PluginLifecycleEventType.Enabled);

    return db.client.pluginLifecycleEvent.findMany({ where: { pluginId, event } });
  };

  /** A remote DataGateway holding `name`, disabled so nothing reaches for a coordinator over it. */
  const holdDataGatewayName = (name: string) =>
    db.client.dataGateway.create({
      data: { name, enabled: false, connectionUrl: 'localhost', connectionPort: 50099, authType: AuthType.None },
    });

  it('an update with nothing for the server to approve is activated at once (#1096)', async () => {
    const admin = await actors.admin();
    const first = await installFirstVersion(admin);
    const next = await nextVersion(first);

    const posted = await upload(admin, next).expect(200);

    expect(posted.body.update).toEqual({
      activeVersion: '1.2.0',
      refusal: null,
      changes: expect.objectContaining({
        activatesAtOnce: true,
        serverGating: false,
        escalations: [],
        deniedRequiredSlugs: [],
        dataGatewayNameConflict: null,
      }),
    });

    const staged = await stage(admin, first.slug, { sha256: next.sha256 }).expect(200);

    expect(staged.body).toMatchObject({ activated: true, dataGatewayNameConflict: null });
    expect(staged.body.message).toContain(`'${first.slug}'`);
    expect(staged.body.message).toContain('1.3.0');
    expect(staged.body.plugin).toMatchObject({
      slug: first.slug,
      version: '1.3.0',
      restartRequired: true,
      restartProcessRoles: ['api'],
      // An upload has no link and no registry, and the update's provenance
      // replaces the first install's.
      provenance: { sha256: next.sha256, url: null, registrySlug: null },
      pendingUpdate: null,
    });

    const row = await pluginRow(first.slug);
    expect(row).toMatchObject({
      version: '1.3.0',
      restartRequired: true,
      installedSha256: next.sha256,
      installedFromUrl: null,
      registrySlug: null,
    });
    expect(stagedColumnsOf(row)).toEqual(NOTHING_STAGED);
    // The plugin's row names the artifact's directory now, so its own row is gone.
    expect(await artifactRow(next.sha256)).toBeNull();

    // A retry after a lost response, before any restart: the same answer,
    // message and all, and nothing activated again (ADR-0002).
    const repeated = await stage(admin, first.slug, { sha256: next.sha256 }).expect(200);

    expect(repeated.body).toEqual(staged.body);
    expect(await settledLifecycleRows(admin, first.slug, PluginLifecycleEventType.UpdateApproved)).toHaveLength(1);
  });

  it('an update that adds a server-consented permission waits for approval (#1096)', async () => {
    const admin = await actors.admin();
    const first = await installFirstVersion(admin);
    const next = await nextVersion(first, WAITS_FOR_APPROVAL);

    const posted = await upload(admin, next).expect(200);

    expect(posted.body.update).toEqual({
      activeVersion: '1.2.0',
      refusal: null,
      changes: expect.objectContaining({
        activatesAtOnce: false,
        serverGating: true,
        escalations: [expect.objectContaining({ kind: 'new-permission', slug: NEW_SERVER_CHECK.slug })],
      }),
    });

    const staged = await stage(admin, first.slug, { sha256: next.sha256 }).expect(200);

    expect(staged.body).toMatchObject({ activated: false, dataGatewayNameConflict: null });
    expect(staged.body.message).toContain('1.3.0');
    expect(staged.body.plugin).toMatchObject({
      version: '1.2.0',
      restartRequired: false,
      restartProcessRoles: [],
      pendingUpdate: { version: '1.3.0', stagingId: expect.any(String) },
    });
    const { stagingId } = staged.body.plugin.pendingUpdate;

    // An upload: the staged update has no link and no registry to carry.
    const whileStaged = await pluginRow(first.slug);
    expect(whileStaged).toMatchObject({
      version: '1.2.0',
      pendingVersion: '1.3.0',
      pendingSha256: next.sha256,
      pendingStagingId: stagingId,
      pendingFromUrl: null,
      pendingRegistrySlug: null,
    });
    expect(await artifactRow(next.sha256)).toBeNull();

    const approved = await approve(admin, first.slug, stagingId).expect(200);

    expect(approved.body.restartRequired).toBe(true);
    expect(approved.body.restartProcessRoles).toEqual(['api']);
    expect(approved.body.message).toContain('api');
    expect(approved.body.plugin.version).toBe('1.3.0');

    const row = await pluginRow(first.slug);
    expect(row).toMatchObject({
      version: '1.3.0',
      installedSha256: next.sha256,
      installedFromUrl: null,
      registrySlug: null,
    });
    expect(stagedColumnsOf(row)).toEqual(NOTHING_STAGED);
  });

  it('posting an update with the wrong checksum changes nothing (#1096)', async () => {
    const admin = await actors.admin();
    const first = await installFirstVersion(admin);
    const next = await nextVersion(first);
    const before = await pluginRow(first.slug);

    const refused = await upload(admin, next, 'f'.repeat(64));

    expectErrorEnvelope(refused, { status: 422, code: 'PLUGIN_ARTIFACT_CHECKSUM_MISMATCH' });
    expect(await pluginRow(first.slug)).toEqual(before);
    // The first version's row went with its install, so none is left for the slug.
    expect(await db.client.pluginArtifact.count({ where: { slug: first.slug } })).toBe(0);
    expect(await exists(join(pluginsRoot(), first.slug, next.sha256))).toBe(false);
  });

  it('a rejected staged update leaves nothing naming its directory, and staging the artifact again makes a staging the old id cannot answer (#357, #1096)', async () => {
    const admin = await actors.admin();
    const first = await installFirstVersion(admin);
    const next = await nextVersion(first, WAITS_FOR_APPROVAL);

    await upload(admin, next).expect(200);
    const staged = await stage(admin, first.slug, { sha256: next.sha256 }).expect(200);
    const oldStagingId: string = staged.body.plugin.pendingUpdate.stagingId;

    await reject(admin, first.slug, oldStagingId).expect(200);

    expect(stagedColumnsOf(await pluginRow(first.slug))).toEqual(NOTHING_STAGED);
    expect(await artifactRow(next.sha256)).toBeNull();

    // The same plugin artifact, posted and staged again.
    const reposted = await upload(admin, next).expect(200);
    expect(reposted.body.update).toMatchObject({ activeVersion: '1.2.0', refusal: null });

    const restaged = await stage(admin, first.slug, { sha256: next.sha256 }).expect(200);
    const newStagingId: string = restaged.body.plugin.pendingUpdate.stagingId;

    expect(newStagingId).toEqual(expect.any(String));
    expect(newStagingId).not.toBe(oldStagingId);

    // An answer reviewed against the first staging must not reach the second.
    expectErrorEnvelope(await approve(admin, first.slug, oldStagingId), {
      status: 409,
      code: 'PLUGIN_UPDATE_STAGING_REPLACED',
    });
    expectErrorEnvelope(await reject(admin, first.slug, oldStagingId), {
      status: 409,
      code: 'PLUGIN_UPDATE_STAGING_REPLACED',
    });

    expect(await pluginRow(first.slug)).toMatchObject({
      version: '1.2.0',
      pendingVersion: '1.3.0',
      pendingSha256: next.sha256,
      pendingStagingId: newStagingId,
    });
  });

  it("uninstalling, then reinstalling, leaves a staged update's directory unnamed (#1096)", async () => {
    const admin = await actors.admin();
    const first = await installFirstVersion(admin);
    const next = await nextVersion(first, WAITS_FOR_APPROVAL);

    await upload(admin, next).expect(200);
    await stage(admin, first.slug, { sha256: next.sha256 }).expect(200);
    expect((await pluginRow(first.slug)).pendingSha256).toBe(next.sha256);

    await uninstall(admin, first.slug).expect(200);

    const uninstalled = await pluginRow(first.slug);
    expect(uninstalled.uninstalledAt).not.toBeNull();
    expect(stagedColumnsOf(uninstalled)).toEqual(NOTHING_STAGED);

    // A reinstall from another artifact of the first version.
    const again = await buildArtifact({
      slug: first.slug,
      manifest: first.manifest,
      indexJs: 'module.exports = () => ({ again: true });\n',
    });
    await upload(admin, again).expect(200);
    await install(admin, { sha256: again.sha256 }).expect(201);

    const reinstalled = await pluginRow(first.slug);
    expect(reinstalled).toMatchObject({ uninstalledAt: null, version: '1.2.0', installedSha256: again.sha256 });
    expect(stagedColumnsOf(reinstalled)).toEqual(NOTHING_STAGED);
  });

  it('a taken DataGateway name is reported before, at and after staging, and the approval names the coordinator once it is free (#1083, #1096)', async () => {
    const admin = await actors.admin();
    const first = await installFirstVersion(admin);
    const holder = await holdDataGatewayName(first.displayName);
    const next = await nextVersion(first, { ...INTO_DATA_GATEWAY, ...WAITS_FOR_APPROVAL });

    // Before: the update waits for approval, so the name can still be freed
    // and staging is not refused.
    const posted = await upload(admin, next).expect(200);

    expect(posted.body.update).toEqual({
      activeVersion: '1.2.0',
      refusal: null,
      changes: expect.objectContaining({
        activatesAtOnce: false,
        serverGating: true,
        dataGatewayNameConflict: first.displayName,
      }),
    });

    // At.
    const staged = await stage(admin, first.slug, { sha256: next.sha256 }).expect(200);

    expect(staged.body).toMatchObject({ activated: false, dataGatewayNameConflict: first.displayName });
    const { stagingId } = staged.body.plugin.pendingUpdate;

    // After.
    const read = await readStaged(admin, first.slug).expect(200);

    expect(read.body.dataGatewayNameConflict).toBe(first.displayName);

    const refused = await approve(admin, first.slug, stagingId);

    expectErrorEnvelope(refused, { status: 409, code: 'PLUGIN_UPDATE_DATA_GATEWAY_NAME_CONFLICT' });
    expect(await pluginRow(first.slug)).toMatchObject({ version: '1.2.0', pendingStagingId: stagingId });

    await db.client.dataGateway.update({ where: { id: holder.id }, data: { name: `${first.displayName} (remote)` } });

    const approved = await approve(admin, first.slug, stagingId).expect(200);

    expect(approved.body.restartProcessRoles).toEqual(['coordinator']);
    expect(approved.body.message).toContain('coordinator');

    const row = await pluginRow(first.slug);
    expect(row.version).toBe('1.3.0');
    expect(await db.client.dataGateway.findUniqueOrThrow({ where: { pluginId: row.id } })).toMatchObject({
      name: first.displayName,
      enabled: true,
    });
  });

  it('an update into data-gateway that would be activated at once is refused under a taken name, and nothing is staged (#1096)', async () => {
    const admin = await actors.admin();
    const first = await installFirstVersion(admin);
    await holdDataGatewayName(first.displayName);
    const next = await nextVersion(first, INTO_DATA_GATEWAY);

    // No update approval would follow in which to free the name, so the
    // artifact step reports the refusal staging would make.
    const posted = await upload(admin, next).expect(200);

    expect(posted.body.update).toEqual({
      activeVersion: '1.2.0',
      refusal: 'data_gateway_name_taken',
      changes: expect.objectContaining({ activatesAtOnce: true, dataGatewayNameConflict: first.displayName }),
    });

    const refused = await stage(admin, first.slug, { sha256: next.sha256 });

    expectErrorEnvelope(refused, { status: 409, code: 'PLUGIN_UPDATE_DATA_GATEWAY_NAME_CONFLICT' });

    const row = await pluginRow(first.slug);
    expect(row).toMatchObject({ version: '1.2.0', installedSha256: first.sha256 });
    expect(stagedColumnsOf(row)).toEqual(NOTHING_STAGED);
    // Kept, so it can be staged once the name is free.
    expect(await artifactRow(next.sha256)).not.toBeNull();
  });

  it("another plugin's artifact is refused (#1096)", async () => {
    const admin = await actors.admin();
    const first = await installFirstVersion(admin);
    const another = await versionOf(freshPluginSlug('staging-other'), '1.3.0');

    await upload(admin, another).expect(200);

    const refused = await stage(admin, first.slug, { sha256: another.sha256 });

    expectErrorEnvelope(refused, { status: 409, code: 'PLUGIN_ARTIFACT_BELONGS_TO_ANOTHER_PLUGIN' });

    const row = await pluginRow(first.slug);
    expect(row).toMatchObject({ version: '1.2.0', installedSha256: first.sha256 });
    expect(stagedColumnsOf(row)).toEqual(NOTHING_STAGED);
    // Kept: it may yet install the plugin it is for.
    expect(await artifactRow(another.sha256)).not.toBeNull();
  });

  it('staging over an uninstalled plugin answers 410, and its artifact response carries no update block (#1096)', async () => {
    const admin = await actors.admin();
    const first = await installFirstVersion(admin);
    const next = await nextVersion(first);

    await uninstall(admin, first.slug).expect(200);

    const posted = await upload(admin, next).expect(200);

    expect(posted.body.update).toBeNull();

    const refused = await stage(admin, first.slug, { sha256: next.sha256 });

    expectErrorEnvelope(refused, { status: 410, code: 'PLUGIN_UPDATE_TOMBSTONED' });
    expect(stagedColumnsOf(await pluginRow(first.slug))).toEqual(NOTHING_STAGED);
  });

  // The artifact routes gate on a type-level manage Plugin, which a key passes
  // whatever plugin its scope names, and the receiver checks only that the
  // key's owner is a server admin. The update block describes the installed
  // plugin, its denials included, so it waits on that plugin's ceiling.
  it('an artifact posted or read through a key scoped to another plugin carries no update block (#1096)', async () => {
    const admin = await actors.admin();
    const first = await installFirstVersion(admin);
    const other = await installFirstVersion(admin);
    const next = await nextVersion(first, WAITS_FOR_APPROVAL);
    await upload(admin, next).expect(200);
    const keyFor = async (slug: string) =>
      mintApiKey(baseUrl, db.client, admin, {
        slugs: ['manage:plugin'],
        resourceType: ResourceType.Plugin,
        resourceId: (await pluginRow(slug)).id,
      });
    const [elsewhere, here] = [await keyFor(other.slug), await keyFor(first.slug)];

    const readElsewhere = await readBack(elsewhere, next.sha256).expect(200);
    const postedElsewhere = await upload(elsewhere, next).expect(200);
    const readHere = await readBack(here, next.sha256).expect(200);
    const postedHere = await upload(here, next).expect(200);

    // Null, as for a slug nobody installed; the rest is the artifact's own.
    expect(readElsewhere.body.update).toBeNull();
    expect(postedElsewhere.body.update).toBeNull();
    expect(readElsewhere.body.artifact.sha256).toBe(next.sha256);
    expect(readHere.body.update).toMatchObject({ activeVersion: '1.2.0', refusal: null });
    expect(readHere.body.update.changes.serverGating).toBe(true);
    expect(postedHere.body.update).toEqual(readHere.body.update);
  });

  it('the staging route refuses an actor without manage Plugin (#1096)', async () => {
    const admin = await actors.admin();
    const user = await actors.user();
    const first = await installFirstVersion(admin);
    const next = await nextVersion(first);
    await upload(admin, next).expect(200);

    await stage(user, first.slug, { sha256: next.sha256 }).expect(403);
    await request(baseUrl).post(`${PLUGINS_PATH}/${first.slug}/update/stage`).send({ sha256: next.sha256 }).expect(401);

    const row = await pluginRow(first.slug);
    expect(row).toMatchObject({ version: '1.2.0', installedSha256: first.sha256 });
    expect(stagedColumnsOf(row)).toEqual(NOTHING_STAGED);
    expect(await artifactRow(next.sha256)).not.toBeNull();
  });

  // Whichever order the two requests run in, the assertions hold, so this
  // cannot fail by timing: it can only catch an update activated twice.
  it('two staging requests at once for one artifact activate the update once (#1096)', async () => {
    const admin = await actors.admin();
    const first = await installFirstVersion(admin);
    const next = await nextVersion(first);
    await upload(admin, next).expect(200);

    const answers = await Promise.all([
      stage(admin, first.slug, { sha256: next.sha256 }),
      stage(admin, first.slug, { sha256: next.sha256 }),
    ]);

    for (const answer of answers) {
      expect({ status: answer.status, body: answer.body }).toMatchObject({
        status: 200,
        body: {
          activated: true,
          plugin: { version: '1.3.0', provenance: { sha256: next.sha256 } },
        },
      });
    }

    expect(await pluginRow(first.slug)).toMatchObject({ version: '1.3.0', installedSha256: next.sha256 });
    expect(await settledLifecycleRows(admin, first.slug, PluginLifecycleEventType.UpdateApproved)).toHaveLength(1);
  });

  // As above: whichever order the two run in, the assertions hold, so this can
  // only catch an update staged twice.
  it('two staging requests at once for one artifact stage it once (#1096)', async () => {
    const admin = await actors.admin();
    const first = await installFirstVersion(admin);
    const next = await nextVersion(first, WAITS_FOR_APPROVAL);
    await upload(admin, next).expect(200);

    const [one, other] = await Promise.all([
      stage(admin, first.slug, { sha256: next.sha256 }),
      stage(admin, first.slug, { sha256: next.sha256 }),
    ]);

    for (const answer of [one, other]) {
      expect({ status: answer.status, body: answer.body }).toMatchObject({
        status: 200,
        body: { activated: false, plugin: { pendingUpdate: { version: '1.3.0', stagingId: expect.any(String) } } },
      });
    }

    const stagingId = one.body.plugin.pendingUpdate.stagingId;
    expect(other.body.plugin.pendingUpdate.stagingId).toBe(stagingId);
    expect(await pluginRow(first.slug)).toMatchObject({ pendingSha256: next.sha256, pendingStagingId: stagingId });
    expect(await settledLifecycleRows(admin, first.slug, PluginLifecycleEventType.UpdatePending)).toHaveLength(1);
  });
});
