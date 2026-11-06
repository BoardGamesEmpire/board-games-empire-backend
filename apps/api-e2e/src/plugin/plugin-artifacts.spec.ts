import { buildPluginTarball, type PluginTarballEntry } from '@bge/plugin-artifacts';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { buildPluginManifest, type PluginManifest } from '@boardgamesempire/plugin-manifest';
import { createHash, randomBytes } from 'node:crypto';
import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import { E2E_PLUGINS_ROOT_VAR, requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

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
  const pluginsRoot = (): string => {
    const root = process.env[E2E_PLUGINS_ROOT_VAR]?.trim();

    if (!root) {
      throw new Error(`${E2E_PLUGINS_ROOT_VAR} is not set: did the e2e globalSetup run?`);
    }

    return root;
  };

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
    readonly bytes: Buffer;
    readonly sha256: string;
  }

  /**
   * A plugin artifact the server accepts. Every name that carries the slug
   * follows it, so each call is its own plugin and no test installs over
   * another. The fixture's `feedback:read` is dropped for the reason the
   * other plugin specs give: no seeded `Permission` row backs it.
   * `bgeCompat` is widened to cover the server's build-time stamp.
   */
  const buildArtifact = async (indexJs = 'module.exports = () => ({});\n'): Promise<BuiltArtifact> => {
    const slug = `ingress-${randomBytes(6).toString('hex')}`;
    const [manageDigest] = buildPluginManifest().permissions.checks;
    const manifest: PluginManifest = {
      ...buildPluginManifest({
        slug,
        bgeCompat: '>=0.0.0',
        permissions: { declares: ['manage:digest'], checks: manageDigest === undefined ? [] : [manageDigest] },
        events: { subscribes: ['feedback.created'], emits: [`plugin.${slug}.digest-sent`] },
        storage: {
          ownTables: [`plugin_${slug.replaceAll('-', '_')}_digests`],
          readsCore: ['Feedback'],
          writesCore: [],
        },
        jobs: { queues: [`plugin:${slug}:digest`], schedules: [{ name: 'weekly-digest', cron: '0 9 * * 1' }] },
      }),
    };
    const entries: PluginTarballEntry[] = [
      { name: 'package/manifest.json', content: JSON.stringify(manifest) },
      {
        name: 'package/package.json',
        content: JSON.stringify({ name: slug, version: manifest.version, main: 'index.js' }),
      },
      { name: 'package/index.js', content: indexJs },
    ];
    const bytes = await buildPluginTarball(entries);

    return { slug, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  };

  const upload = (actor: SessionActor, artifact: BuiltArtifact, expectedSha256: string = artifact.sha256) =>
    request(baseUrl)
      .post(ARTIFACTS_PATH)
      .set(actor.headers)
      .field('sha256', expectedSha256)
      .attach('file', artifact.bytes, { filename: `${artifact.slug}.tgz`, contentType: 'application/gzip' });

  const readBack = (actor: SessionActor, sha256: string) =>
    request(baseUrl).get(`${ARTIFACTS_PATH}/${sha256}`).set(actor.headers);

  const install = (actor: SessionActor, body: Record<string, unknown>) =>
    request(baseUrl).post(INSTALL_PATH).set(actor.headers).send(body);

  const exists = (path: string): Promise<boolean> =>
    access(path).then(
      () => true,
      () => false,
    );

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

  it('a checksum mismatch by upload keeps nothing (#1094)', async () => {
    const admin = await actors.admin();
    const artifact = await buildArtifact();

    const refused = await upload(admin, artifact, 'f'.repeat(64)).expect(422);

    expect(refused.body.code).toBe('PluginArtifactChecksumMismatchError');
    expect(await exists(join(pluginsRoot(), artifact.slug))).toBe(false);
    expect(await db.client.pluginArtifact.count({ where: { slug: artifact.slug } })).toBe(0);
    expect(await incoming()).toEqual([]);
  });

  it('a raw DatabaseService import must be accepted per specifier (#1094)', async () => {
    const admin = await actors.admin();
    const artifact = await buildArtifact(
      "const { DatabaseService } = require('@bge/database');\nmodule.exports = DatabaseService;\n",
    );

    const posted = await upload(admin, artifact).expect(200);

    expect(posted.body.forbiddenImportsToAccept).toEqual(['@bge/database']);

    const challenged = await install(admin, { sha256: artifact.sha256 }).expect(409);

    expect(challenged.body.code).toBe('PluginInstallStaticAnalysisError');
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

    expect(refused.body.code).toBe('PluginArtifactLinkRefusedError');
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

    expect(refused.body.code).toBe('PluginArtifactNotFoundError');
  });
});
