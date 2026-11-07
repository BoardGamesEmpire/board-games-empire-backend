import { PluginCategory, PluginScope, RiskLevel, type Plugin, type PrismaClient } from '@bge/database';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import { randomUUID } from 'node:crypto';
import { INVENTORY_STAGING_ID, pluginRowData, stagedUpdateColumns } from './plugin-row-fixtures';

/** Re-exported: the staging id (#357) on every update `arrangeInventoryPlugin` stages; approve and reject must send it. */
export { INVENTORY_STAGING_ID };

export interface InventoryPluginOptions {
  /** Columns written over the installed defaults: `uninstalledAt`, `scope`, and so on. */
  readonly row?: Record<string, unknown>;
  /** Stages an update to this version: the same manifest, pending approval. */
  readonly stagedVersion?: string;
}

/**
 * An installed plugin with a valid manifest, for the suites that send the
 * plugin routes real requests, which validate it.
 *
 * A distinct slug per plugin, because the list reads ENUMERATE: a suite-wide
 * fixture slug would let one test's rows appear in another's page. Tests
 * therefore assert against their own slug rather than on page contents.
 */
export const arrangeInventoryPlugin = async (
  prisma: PrismaClient,
  options: InventoryPluginOptions = {},
): Promise<Plugin> => {
  const slug = `inv-${randomUUID().slice(0, 8)}`;
  const manifest = buildPluginManifest({
    slug,
    bgeCompat: '>=0.0.0',
    displayName: { en: 'Inventory Fixture', de: 'Bestandsvorrichtung' },
    description: { en: 'Fixture for the inventory reads.' },
    events: { emits: [`plugin.${slug}.digest-sent`], subscribes: ['feedback.created'] },
    jobs: { queues: [`plugin:${slug}:digest`] },
    storage: { ownTables: [`plugin_${slug.replace(/-/g, '_')}_digests`] },
    permissions: {
      declares: ['manage:digest'],
      checks: [
        {
          slug: 'manage:digest',
          required: true,
          reason: { en: 'Stores and manages the digest configuration it owns.' },
          consentScope: 'server',
          feature: 'weekly-digest',
        },
      ],
    },
  });

  const staged =
    options.stagedVersion === undefined
      ? {}
      : stagedUpdateColumns({ manifest: { ...manifest, version: options.stagedVersion } });

  const plugin = await prisma.plugin.create({
    data: pluginRowData({
      slug,
      version: manifest.version,
      category: PluginCategory.FeedbackSink,
      scope: manifest.scope === 'server' ? PluginScope.Server : PluginScope.Household,
      manifestJson: manifest as never,
      enabled: true,
      installedFromUrl: 'https://registry.test/fixture.tgz',
      ...staged,
      ...options.row,
    }),
  });
  await prisma.pluginPermission.create({
    data: { pluginId: plugin.id, slug: `plugin|${slug}|manage:digest`, riskLevel: RiskLevel.Low },
  });

  return plugin;
};
