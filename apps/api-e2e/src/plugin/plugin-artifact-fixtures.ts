import { buildPluginTarball, type PluginTarballEntry } from '@bge/plugin-artifacts';
import {
  buildPluginManifest,
  resolveLocalizedString,
  type PluginManifest,
  type PluginManifestOverrides,
} from '@boardgamesempire/plugin-manifest';
import { createHash, randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';
import request from 'supertest';
import type { Caller } from '../support/api-key';
import { deferredRequest } from '../support/deferred-request';
import { E2E_PLUGINS_ROOT_VAR } from '../support/e2e-env';
import { readArtifactShownRisks } from './consent-act-fixtures';

/**
 * Plugin artifacts built, posted and installed through the real api (#1094),
 * shared by the install ingress spec and the update staging spec (#1096).
 */

export const ARTIFACTS_PATH = '/api/plugins/artifacts';
export const INSTALL_PATH = '/api/plugins/install';

export interface BuiltArtifact {
  readonly bytes: Buffer;
  /** The display name in the server default locale: the name a data-gateway plugin's DataGateway takes. */
  readonly displayName: string;

  readonly manifest: PluginManifest;
  readonly sha256: string;
  readonly slug: string;
  readonly version: string;
}

export interface ArtifactOptions {
  /** Requested permissions added after the fixture's own. */
  readonly extraChecks?: PluginManifest['permissions']['checks'];

  /** Changes the bytes, so a second artifact of one manifest has its own checksum. */
  readonly indexJs?: string;

  /**
   * Written over the manifest built for the slug, as `buildPluginManifest`
   * merges its overrides: `version` for a second version of one slug,
   * `category`, `displayName` or `permissions` for what that version changes.
   */
  readonly manifest?: PluginManifestOverrides;

  /** Defaults to a fresh `ingress-` slug, so each call is its own plugin. */
  readonly slug?: string;
}

/** A slug no other test uses. */
export const freshPluginSlug = (prefix: string): string => `${prefix}-${randomBytes(6).toString('hex')}`;

/**
 * A plugin manifest the server accepts for `slug`. Every name that carries the
 * slug follows it. The fixture's `feedback:read` is dropped for the reason the
 * other plugin specs give: no seeded `Permission` row backs it. `bgeCompat` is
 * widened to cover the server's build-time stamp.
 *
 * `overrides` merge as `buildPluginManifest` merges its own: a nested section
 * merges one level deep over this artifact's, so a partial `storage` keeps
 * the slug's table rather than the fixture's (#1096).
 */
export const artifactManifest = (
  slug: string,
  overrides: PluginManifestOverrides = {},
  extraChecks: PluginManifest['permissions']['checks'] = [],
): PluginManifest => {
  const [manageDigest] = buildPluginManifest().permissions.checks;
  const { permissions, events, storage, jobs, ...rest } = overrides;

  return buildPluginManifest({
    slug,
    bgeCompat: '>=0.0.0',
    ...rest,
    permissions: {
      declares: ['manage:digest'],
      checks: [...(manageDigest === undefined ? [] : [manageDigest]), ...extraChecks],
      ...permissions,
    },
    events: { subscribes: ['feedback.created'], emits: [`plugin.${slug}.digest-sent`], ...events },
    storage: {
      ownTables: [`plugin_${slug.replaceAll('-', '_')}_digests`],
      readsCore: ['Feedback'],
      writesCore: [],
      ...storage,
    },
    jobs: {
      queues: [`plugin.${slug}.digest`],
      schedules: [{ name: 'weekly-digest', cron: '0 9 * * 1' }],
      ...jobs,
    },
  });
};

/** A plugin artifact the server accepts: a tarball of the manifest, its package file and `index.js`. */
export const buildArtifact = async (options: ArtifactOptions = {}): Promise<BuiltArtifact> => {
  const slug = options.slug ?? freshPluginSlug('ingress');
  const manifest = artifactManifest(slug, options.manifest, options.extraChecks);
  const entries: PluginTarballEntry[] = [
    { name: 'package/manifest.json', content: JSON.stringify(manifest) },
    {
      name: 'package/package.json',
      content: JSON.stringify({ name: slug, version: manifest.version, main: 'index.js' }),
    },
    { name: 'package/index.js', content: options.indexJs ?? 'module.exports = () => ({});\n' },
  ];
  const bytes = await buildPluginTarball(entries);

  return {
    slug,
    version: manifest.version,
    // The e2e server's default locale is English.
    displayName: resolveLocalizedString(manifest.displayName, { locale: 'en', defaultLocale: 'en' }),
    manifest,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
};

/** The artifact routes, for one api, as a session or an API key calls them. */
export const artifactRoutes = (baseUrl: string) => ({
  /** Posts the artifact by upload, with the checksum the server admin expects. */
  upload: (actor: Caller, artifact: BuiltArtifact, expectedSha256: string = artifact.sha256) =>
    request(baseUrl)
      .post(ARTIFACTS_PATH)
      .set(actor.headers)
      .field('sha256', expectedSha256)
      .attach('file', artifact.bytes, { filename: `${artifact.slug}.tgz`, contentType: 'application/gzip' }),

  readBack: (actor: Caller, sha256: string) => request(baseUrl).get(`${ARTIFACTS_PATH}/${sha256}`).set(actor.headers),

  /** Sends the risks the artifact read shows, as a client would; a spec's body overrides them (#1336). */
  install: (actor: Caller, body: { readonly sha256: string } & Record<string, unknown>) =>
    deferredRequest(
      () => readArtifactShownRisks(baseUrl, actor, body.sha256),
      (shownRisks) =>
        request(baseUrl)
          .post(INSTALL_PATH)
          .set(actor.headers)
          .send({ shownRisks, ...body }),
    ),
});

/** The plugins root the e2e harness gave the api. */
export const pluginsRoot = (): string => {
  const root = process.env[E2E_PLUGINS_ROOT_VAR]?.trim();

  if (!root) {
    throw new Error(`${E2E_PLUGINS_ROOT_VAR} is not set: did the e2e globalSetup run?`);
  }

  return root;
};

export const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );
