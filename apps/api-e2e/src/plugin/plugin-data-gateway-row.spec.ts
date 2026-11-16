import { AuthType, PluginCategory, PluginScope } from '@bge/database';
import { buildPluginTarball, type PluginTarballEntry } from '@bge/plugin-artifacts';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { buildPluginManifest, type PluginManifest } from '@boardgamesempire/plugin-manifest';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { pluginRowData, stagedUpdateColumns } from './plugin-row-fixtures';

/**
 * A data-gateway plugin's DataGateway row through the plugin's life, against
 * Postgres (#1083): the CHECK on the row's kind, the foreign key to the plugin,
 * the unique indexes and the real transactions, none of which a mocked
 * `DatabaseService` has. Installing creates the row, enabled. Uninstalling
 * disables it and keeps it, with the game sources imported through it.
 * Reinstalling enables the same row again. An approved update that moves the
 * plugin into or out of the data-gateway category makes the row follow.
 *
 * Every step goes through the api: the artifact step, then the install, and
 * the uninstall route. The update cases stage on the plugin's row, since no
 * route stages one, and approve through the api. No coordinator runs here, so
 * nothing calls the routes that reach one (the DataGateway connect and
 * interview routes).
 */
describe('a data-gateway plugin’s DataGateway row (#1083)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const ARTIFACTS_PATH = '/api/plugins/artifacts';
  const INSTALL_PATH = '/api/plugins/install';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  interface BuiltArtifact {
    readonly slug: string;
    /** The DataGateway name the install takes: the display name in the server default locale. */
    readonly displayName: string;
    readonly bytes: Buffer;
    readonly sha256: string;
  }

  /**
   * A plugin manifest the server accepts, built as the install ingress spec
   * builds its own: every name that carries the slug follows it,
   * `feedback:read` is dropped for want of a seeded `Permission` row, and
   * `bgeCompat` covers the server's build-time stamp.
   */
  const manifestFor = (
    slug: string,
    displayName: string,
    overrides: Pick<Partial<PluginManifest>, 'category' | 'version'> = {},
  ): PluginManifest => {
    const [manageDigest] = buildPluginManifest().permissions.checks;

    return buildPluginManifest({
      slug,
      category: 'data-gateway',
      displayName: { en: displayName },
      bgeCompat: '>=0.0.0',
      permissions: { declares: ['manage:digest'], checks: manageDigest === undefined ? [] : [manageDigest] },
      events: { subscribes: ['feedback.created'], emits: [`plugin.${slug}.digest-sent`] },
      storage: {
        ownTables: [`plugin_${slug.replaceAll('-', '_')}_digests`],
        readsCore: ['Feedback'],
        writesCore: [],
      },
      jobs: { queues: [`plugin.${slug}.digest`], schedules: [{ name: 'weekly-digest', cron: '0 9 * * 1' }] },
      ...overrides,
    });
  };

  /**
   * A data-gateway plugin artifact the server accepts. `indexJs` changes the
   * bytes, so a second artifact for the same slug has its own checksum.
   */
  const buildArtifact = async (
    slug = `dg-row-${randomBytes(6).toString('hex')}`,
    indexJs = 'module.exports = () => ({});\n',
  ): Promise<BuiltArtifact> => {
    const displayName = `Row Life ${slug}`;
    const manifest = manifestFor(slug, displayName);
    const entries: PluginTarballEntry[] = [
      { name: 'package/manifest.json', content: JSON.stringify(manifest) },
      {
        name: 'package/package.json',
        content: JSON.stringify({ name: slug, version: manifest.version, main: 'index.js' }),
      },
      { name: 'package/index.js', content: indexJs },
    ];
    const bytes = await buildPluginTarball(entries);

    return { slug, displayName, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  };

  const upload = (actor: SessionActor, artifact: BuiltArtifact) =>
    request(baseUrl)
      .post(ARTIFACTS_PATH)
      .set(actor.headers)
      .field('sha256', artifact.sha256)
      .attach('file', artifact.bytes, { filename: `${artifact.slug}.tgz`, contentType: 'application/gzip' });

  const install = (actor: SessionActor, artifact: BuiltArtifact) =>
    request(baseUrl).post(INSTALL_PATH).set(actor.headers).send({ sha256: artifact.sha256 });

  /** The artifact step, then the install, each answered as a success. */
  const uploadAndInstall = async (actor: SessionActor, artifact: BuiltArtifact) => {
    const posted = await upload(actor, artifact).expect(200);
    expect(posted.body.dataGatewayNameConflict).toBeNull();

    return install(actor, artifact).expect(201);
  };

  const pluginOf = (slug: string) => db.client.plugin.findUniqueOrThrow({ where: { slug } });

  it('install creates the row, uninstall disables it and keeps it with its game sources, reinstall enables it again (#1083)', async () => {
    const admin = await actors.admin();
    const artifact = await buildArtifact();

    await uploadAndInstall(admin, artifact);

    const installed = await pluginOf(artifact.slug);
    const row = await db.client.dataGateway.findUniqueOrThrow({ where: { pluginId: installed.id } });

    // A plugin DataGateway: named from the manifest's display name, enabled,
    // its plugin's id and none of a remote DataGateway's connection fields.
    expect(row).toMatchObject({
      name: artifact.displayName,
      enabled: true,
      pluginId: installed.id,
      connectionUrl: null,
      connectionPort: null,
      authType: null,
      deletedAt: null,
    });

    // What an import through the DataGateway leaves behind.
    const game = await db.client.game.create({
      data: { title: `Imported via ${artifact.slug}` },
      select: { id: true },
    });
    const source = await db.client.gameSource.create({
      data: { gameId: game.id, gatewayId: row.id, externalId: 'external-1' },
      select: { id: true },
    });

    await request(baseUrl).post(`/api/plugins/${artifact.slug}/uninstall`).set(admin.headers).send({}).expect(200);

    // The same row, disabled and still there, and the game source with it.
    expect((await pluginOf(artifact.slug)).uninstalledAt).not.toBeNull();
    expect(await db.client.dataGateway.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      enabled: false,
      pluginId: installed.id,
      deletedAt: null,
    });
    expect(await db.client.gameSource.findUnique({ where: { id: source.id } })).toMatchObject({ gatewayId: row.id });

    // A new artifact for the same slug: a reinstall, which keeps the plugin's id.
    const again = await buildArtifact(artifact.slug, 'module.exports = () => ({ again: true });\n');
    await uploadAndInstall(admin, again);

    const reinstalled = await pluginOf(artifact.slug);
    expect(reinstalled).toMatchObject({ id: installed.id, uninstalledAt: null });
    // A reinstall names a new install, which the gateway registry's routing reads.
    expect(reinstalled.installedAt.getTime()).toBeGreaterThan(installed.installedAt.getTime());
    expect(await db.client.dataGateway.findMany({ where: { pluginId: installed.id } })).toEqual([
      expect.objectContaining({ id: row.id, enabled: true, name: artifact.displayName }),
    ]);
    expect(await db.client.gameSource.findUnique({ where: { id: source.id } })).toMatchObject({ gatewayId: row.id });
  });

  it('a remote DataGateway holding the name refuses the install, and nothing is written (#1083)', async () => {
    const admin = await actors.admin();
    const artifact = await buildArtifact();
    // Disabled, so nothing would reach for a coordinator over it.
    const remote = await db.client.dataGateway.create({
      data: {
        name: artifact.displayName,
        enabled: false,
        connectionUrl: 'localhost',
        connectionPort: 50099,
        authType: AuthType.None,
      },
    });

    // The artifact step says so ahead of the install.
    const posted = await upload(admin, artifact).expect(200);
    expect(posted.body.dataGatewayNameConflict).toBe(artifact.displayName);

    const refused = await install(admin, artifact);

    expectErrorEnvelope(refused, { status: 409, code: 'PLUGIN_INSTALL_DATA_GATEWAY_NAME_CONFLICT' });
    expect(refused.body.message).toContain(`'${artifact.displayName}'`);
    expect(await db.client.plugin.findUnique({ where: { slug: artifact.slug } })).toBeNull();
    expect(await db.client.dataGateway.findMany({ where: { name: artifact.displayName } })).toEqual([
      expect.objectContaining({ id: remote.id, pluginId: null }),
    ]);
    expect(await db.client.dataGateway.count({ where: { pluginId: { not: null } } })).toBe(0);
  });

  describe('an update that moves the plugin into or out of the data-gateway category (#1083)', () => {
    /** A plugin installed in another category, as its row reads, with nothing staged. */
    const arrangePlugin = async (category: PluginManifest['category'] = 'feedback-sink') => {
      const slug = `dg-move-${randomBytes(6).toString('hex')}`;
      const displayName = `Moved ${slug}`;
      const plugin = await db.client.plugin.create({
        data: pluginRowData({
          slug,
          version: '1.2.0',
          category: category === 'data-gateway' ? PluginCategory.DataGateway : PluginCategory.FeedbackSink,
          scope: PluginScope.Server,
          manifestJson: manifestFor(slug, displayName, { category, version: '1.2.0' }) as never,
          enabled: true,
        }),
      });

      return { plugin, slug, displayName };
    };

    /** Stages the next version on the row, in `category`, and approves it through the api. */
    const stageAndApprove = async (
      actor: SessionActor,
      plugin: { readonly id: string; readonly slug: string },
      displayName: string,
      version: string,
      category: PluginManifest['category'],
    ) => {
      const stagingId = `e2e-move-${randomBytes(6).toString('hex')}`;
      await db.client.plugin.update({
        where: { id: plugin.id },
        data: stagedUpdateColumns({
          manifest: manifestFor(plugin.slug, displayName, { category, version }),
          stagingId,
        }),
      });

      return request(baseUrl).post(`/api/plugins/${plugin.slug}/update/approve`).set(actor.headers).send({ stagingId });
    };

    it('creates the row when an approved update makes the plugin a data-gateway plugin, and disables and keeps it when the next moves it out (#1083)', async () => {
      const admin = await actors.admin();
      const { plugin, displayName } = await arrangePlugin();
      expect(await db.client.dataGateway.count({ where: { pluginId: plugin.id } })).toBe(0);

      const movedIn = await stageAndApprove(admin, plugin, displayName, '1.3.0', 'data-gateway');
      expect({ status: movedIn.status, body: movedIn.body }).toMatchObject({ status: 200 });

      expect(await pluginOf(plugin.slug)).toMatchObject({ version: '1.3.0', category: PluginCategory.DataGateway });
      const row = await db.client.dataGateway.findUniqueOrThrow({ where: { pluginId: plugin.id } });
      expect(row).toMatchObject({
        name: displayName,
        enabled: true,
        connectionUrl: null,
        connectionPort: null,
        authType: null,
        createdById: admin.user.id,
        deletedAt: null,
      });

      const movedOut = await stageAndApprove(admin, plugin, displayName, '1.4.0', 'feedback-sink');
      expect({ status: movedOut.status, body: movedOut.body }).toMatchObject({ status: 200 });

      expect(await pluginOf(plugin.slug)).toMatchObject({ version: '1.4.0', category: PluginCategory.FeedbackSink });
      expect(await db.client.dataGateway.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
        enabled: false,
        pluginId: plugin.id,
        deletedAt: null,
      });
    });

    it("leaves a DataGateway an admin disabled as it is through its plugin's next version (#1083)", async () => {
      const admin = await actors.admin();
      const { plugin, displayName } = await arrangePlugin('data-gateway');
      const row = await db.client.dataGateway.create({
        data: { name: displayName, pluginId: plugin.id, enabled: false },
      });

      const updated = await stageAndApprove(admin, plugin, displayName, '1.3.0', 'data-gateway');
      expect({ status: updated.status, body: updated.body }).toMatchObject({ status: 200 });

      expect(await db.client.dataGateway.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
        enabled: false,
      });
    });

    it('refuses the approval when another DataGateway holds the name, and the update stays staged with nothing activated (#1083)', async () => {
      const admin = await actors.admin();
      const { plugin, displayName } = await arrangePlugin();
      const remote = await db.client.dataGateway.create({
        data: {
          name: displayName,
          enabled: false,
          connectionUrl: 'localhost',
          connectionPort: 50099,
          authType: AuthType.None,
        },
      });

      const refused = await stageAndApprove(admin, plugin, displayName, '1.3.0', 'data-gateway');

      expectErrorEnvelope(refused, { status: 409, code: 'PLUGIN_UPDATE_DATA_GATEWAY_NAME_CONFLICT' });
      expect(refused.body.message).toContain(`'${displayName}'`);
      expect(refused.body.dataGatewayName).toBe(displayName);
      // The claim went back with the refusal: the old version is active and the update is still staged.
      expect(await pluginOf(plugin.slug)).toMatchObject({
        version: '1.2.0',
        category: PluginCategory.FeedbackSink,
        pendingVersion: '1.3.0',
      });
      expect(await db.client.dataGateway.findMany({ where: { name: displayName } })).toEqual([
        expect.objectContaining({ id: remote.id, pluginId: null }),
      ]);
    });
  });
});
