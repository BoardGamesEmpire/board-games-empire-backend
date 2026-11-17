import type { Prisma, PrismaClient } from '@bge/database';
import { PluginCategory, PluginScope } from '@bge/database';
import { FALLBACK_LOCALE } from '@bge/i18n';
import { BGE_VERSION } from '@bge/version';
import type { PluginManifest } from '@boardgamesempire/plugin-manifest';
import { resolveLocalizedString, validatePluginManifest } from '@boardgamesempire/plugin-manifest';
import { afterAll, beforeAll } from '@jest/globals';
import { build as bundle } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { FixtureBuild } from './fixture-build';
import { FIRST_BUILD } from './fixture-build';

/**
 * Puts the fixture plugin where the coordinator finds an installed plugin
 * (#1083): its files under a plugins root, in the artifact directory the
 * install ingress would place them in, and its rows as an install leaves
 * them once a server admin has switched the plugin on. No api runs in this
 * suite, so nothing installs: the files and the rows are written directly.
 */

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'in-memory-gateway-plugin');
const STUBS_DIR = path.join(FIXTURE_DIR, 'stubs');

/** The export condition that resolves a workspace package to its sources, as `tsconfig.base.json` names it. */
const WORKSPACE_SOURCE_CONDITION = '@board-games-empire/backend';

/** The fixture's entries: its plugin, and one whose factory returns no driver factory. */
export type FixtureEntry = 'index' | 'not-a-factory';

export interface FixturePlacement {
  readonly entry: FixtureEntry;

  /** The plugin's slug, which names its directory under the plugins root and its rows. */
  readonly slug: string;

  /** What the entry is built with: {@link FIRST_BUILD} unless set. */
  readonly build?: FixtureBuild;
}

/** One version of the fixture plugin as it lies under a plugins root, in its artifact directory. */
export interface PlacedPlugin {
  readonly slug: string;
  readonly version: string;

  /** The checksum its artifact directory is named for, which its row records as `installedSha256`. */
  readonly sha256: string;

  /** The plugin manifest written beside its code. */
  readonly manifest: Record<string, unknown>;
}

export interface SeededPlugin {
  readonly pluginId: string;

  /** The plugin's DataGateway row. */
  readonly gatewayId: string;

  /** The install the rows name. */
  readonly installedAt: Date;
}

/**
 * Makes a plugins root for the spec file that calls it, in `beforeAll`: a
 * fresh directory outside the workspace, as a deployment's is, so nothing a
 * plugin imports can resolve from the workspace's `node_modules`. `afterAll`
 * removes it. The returned function names the directory.
 */
export function usePluginsRoot(): () => string {
  let root: string | undefined;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bge-coordinator-e2e-plugins-'));
  });

  afterAll(async () => {
    const removing = root;
    root = undefined;

    if (removing !== undefined) {
      await rm(removing, { recursive: true, force: true });
    }
  });

  return () => {
    if (root === undefined) {
      throw new Error('The plugins root is not made: usePluginsRoot() makes it in beforeAll');
    }

    return root;
  };
}

/**
 * Bundles one of the fixture's entries with esbuild into a single file and
 * places it at `<pluginsRoot>/<slug>/<sha256>/dist/index.js`, beside its
 * plugin manifest and its `package.json`.
 *
 * The file is an ES module. The plugin loader imports a plugin with
 * `import()` and takes the module's default export as the plugin's factory,
 * and that is the factory itself only for an ES module. Of a CommonJS file
 * compiled from `export default`, `import()` gives `module.exports`, which
 * holds the factory one level down, and the loader refuses it.
 *
 * It carries everything it runs, as a plugin artifact does: the plugins root
 * is outside the workspace, so nothing resolves from `node_modules` when the
 * coordinator imports it. `@nestjs/microservices` and `@jest/globals`, which
 * the workspace packages it bundles import and the plugin never calls, are
 * swapped for the stubs beside the fixture.
 *
 * The directory is named for a checksum of the three files. An install names
 * it for the checksum of the plugin artifact it received. Either way the name
 * is what the row records, and two builds get two directories.
 */
export async function placeFixturePlugin(pluginsRoot: string, placement: FixturePlacement): Promise<PlacedPlugin> {
  const { entry, slug, build = FIRST_BUILD } = placement;

  const bundled = await bundle({
    entryPoints: [path.join(FIXTURE_DIR, 'src', `${entry}.ts`)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    conditions: [WORKSPACE_SOURCE_CONDITION],
    alias: {
      '@nestjs/microservices': path.join(STUBS_DIR, 'nestjs-microservices.ts'),
      '@jest/globals': path.join(STUBS_DIR, 'jest-globals.ts'),
    },
    define: { __FIXTURE_BUILD__: JSON.stringify(build) },
    write: false,
    logLevel: 'silent',
  });

  if (bundled.warnings.length > 0) {
    throw new Error(
      `Bundling the fixture plugin's '${entry}' entry warned: ${bundled.warnings.map((warning) => warning.text).join('; ')}`,
    );
  }

  const [code] = bundled.outputFiles;

  const manifest: Record<string, unknown> = {
    ...(JSON.parse(await readFile(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8')) as Record<string, unknown>),
    slug,
    version: build.version,
  };

  // Written here and not kept beside the fixture's sources: Nx reads a
  // `package.json` anywhere under a project as a project of its own. What it
  // says follows from the build above, an ES module at `dist/index.js`.
  const descriptor = { name: slug, version: build.version, type: 'module', main: './dist/index.js' };

  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const descriptorText = `${JSON.stringify(descriptor, null, 2)}\n`;

  const sha256 = createHash('sha256').update(code.contents).update(manifestText).update(descriptorText).digest('hex');

  const directory = path.join(pluginsRoot, slug, sha256);
  await mkdir(path.join(directory, 'dist'), { recursive: true });
  await writeFile(path.join(directory, 'dist', 'index.js'), code.contents);
  await writeFile(path.join(directory, 'manifest.json'), manifestText);
  await writeFile(path.join(directory, 'package.json'), descriptorText);

  return { slug, version: build.version, sha256, manifest };
}

/**
 * The placed plugin manifest, validated against the running version as
 * install and an update's activation validate one before they write. So a
 * fixture manifest an install would refuse fails here, not as a quarantine
 * in the coordinator.
 */
function validatedManifest(placed: PlacedPlugin): PluginManifest {
  return validatePluginManifest(placed.manifest, { bgeVersion: BGE_VERSION, defaultLocale: FALLBACK_LOCALE }).manifest;
}

/** The plugin manifest as a plugin's row stores it, in `manifestJson`: the validated one. */
export function storedManifest(placed: PlacedPlugin): Prisma.InputJsonValue {
  // A validated manifest is plain JSON. Its config schema is typed as a
  // record of unknown values, which Prisma's JSON input type doesn't take.
  return validatedManifest(placed) as Prisma.InputJsonValue;
}

/**
 * Writes the rows of a data-gateway plugin that was installed from `placed`
 * and then switched on: the `Plugin` row and its DataGateway row, with the
 * columns `PluginInstallerService` writes for a manual upload.
 *
 * Two columns are the switch-on's, not the install's. An install leaves a
 * plugin's server switch off, and a server admin turns it on: `enabled`.
 * Nothing has loaded the plugin at that point, so the switch-on marks it
 * `restartRequired`, which the boot that loads it clears.
 *
 * The installing server admin is a `User` row written directly: the
 * DataGateway row names its creator by a foreign key.
 */
export async function seedPluginRows(db: PrismaClient, placed: PlacedPlugin): Promise<SeededPlugin> {
  const manifest = validatedManifest(placed);

  const handle = randomUUID();
  const installer = await db.user.create({
    data: { username: `plugin-installer-${handle}`, email: `plugin-installer-${handle}@example.test` },
    select: { id: true },
  });

  const installedAt = new Date();
  const plugin = await db.plugin.create({
    data: {
      slug: manifest.slug,
      version: manifest.version,
      category: PluginCategory.DataGateway,
      scope: PluginScope.Server,
      manifestJson: storedManifest(placed),
      installedFromUrl: null,
      installedSha256: placed.sha256,
      registrySlug: null,
      installedById: installer.id,
      installedAt,
      enabled: true,
      restartRequired: true,
    },
    select: { id: true },
  });

  const gateway = await db.dataGateway.create({
    data: {
      name: resolveLocalizedString(manifest.displayName, { locale: FALLBACK_LOCALE, defaultLocale: FALLBACK_LOCALE }),
      pluginId: plugin.id,
      enabled: true,
      createdById: installer.id,
    },
    select: { id: true },
  });

  return { pluginId: plugin.id, gatewayId: gateway.id, installedAt };
}

/**
 * Removes every plugin's rows, each DataGateway row and each plugin load
 * record. A coordinator loads every data-gateway plugin the database holds,
 * so a spec file clears what the file before it left before it seeds its
 * own. The DataGateway rows go first: each plugin's row is held by its
 * DataGateway's.
 */
export async function clearPluginRows(db: PrismaClient): Promise<void> {
  await db.dataGateway.deleteMany({});
  await db.plugin.deleteMany({});
  await db.pluginProcessLoad.deleteMany({});
}
