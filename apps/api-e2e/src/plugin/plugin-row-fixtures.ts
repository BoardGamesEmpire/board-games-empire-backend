import { PluginCategory, PluginScope, type Prisma } from '@bge/database';
import { buildPluginManifest, type PluginManifest } from '@boardgamesempire/plugin-manifest';
import { randomUUID } from 'node:crypto';

/** The staging id (#357) a staged update carries by default; approve and reject must send it. */
export const INVENTORY_STAGING_ID = 'e2e-staging-1';

/** The checksum every fixture plugin row is installed from. */
export const INSTALLED_SHA256 = 'a'.repeat(64);

/**
 * The consent act a consent decision arranged directly on its row names
 * (#1336). Every decision names the act that wrote it, but `act_id` has no
 * foreign key, so a suite that arranges the decision rather than the act needs
 * only an id, not a `plugin_consent_acts` row.
 */
export const FIXTURE_ACT_ID = 'e2e-fixture-act';

/**
 * An installed plugin row, enabled-false, for `plugin.create({ data })` (#1118).
 *
 * Every e2e suite that arranges a plugin row goes through here, so a column
 * the installed state gains (#1094) gets its default in one place. The slug is
 * fresh per call; a suite that needs the manifest's own slug passes it, with
 * the manifest. The default manifest is a minimal document, not a valid one:
 * a suite that sends real requests passes `buildPluginManifest()`'s output.
 */
export function pluginRowData(
  overrides: Partial<Prisma.PluginUncheckedCreateInput> = {},
): Prisma.PluginUncheckedCreateInput {
  const slug = overrides.slug ?? `plugin-row-${randomUUID()}`;
  const version = overrides.version ?? '1.0.0';

  return {
    slug,
    version,
    category: PluginCategory.FeedbackSink,
    scope: PluginScope.Household,
    manifestJson: { slug, version },
    enabled: false,
    installedSha256: INSTALLED_SHA256,
    ...overrides,
  };
}

type StagedUpdateColumns = Pick<
  Prisma.PluginUncheckedCreateInput,
  | 'pendingVersion'
  | 'pendingManifestJson'
  | 'pendingSha256'
  | 'pendingSince'
  | 'pendingStagingId'
  | 'pendingFromUrl'
  | 'pendingRegistrySlug'
>;

/**
 * The five columns of a staged update, all set. They are exactly the set the
 * `plugins_staged_update_all_or_nothing` CHECK requires: set some and not the
 * others, and Postgres refuses the row (#357). The artifact's link and
 * registry (#1096) are null by default, as for an upload; they sit outside
 * that set and may be set only while an update is staged.
 */
export function stagedUpdateColumns(
  overrides: {
    readonly version?: string;
    readonly manifest?: PluginManifest;
    readonly sha256?: string;
    readonly stagingId?: string;
    /** When the update was staged. Defaults to now. */
    readonly since?: Date;

    /** The link the staged artifact was fetched from (#1096). Defaults to null, as for an upload. */
    readonly url?: string;

    /** The registry the staged artifact came from (#1096). Defaults to null, as for an upload. */
    readonly registrySlug?: string;
  } = {},
): StagedUpdateColumns {
  const version = overrides.version ?? overrides.manifest?.version ?? '1.3.0';
  const manifest = overrides.manifest ?? { ...buildPluginManifest(), version };

  return {
    pendingVersion: version,
    pendingManifestJson: manifest as never,
    pendingSha256: overrides.sha256 ?? 'b'.repeat(64),
    pendingSince: overrides.since ?? new Date(),
    pendingStagingId: overrides.stagingId ?? INVENTORY_STAGING_ID,
    pendingFromUrl: overrides.url ?? null,
    pendingRegistrySlug: overrides.registrySlug ?? null,
  };
}
