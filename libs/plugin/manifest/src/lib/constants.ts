/**
 * Shared vocabulary for the plugin manifest (issue #59, Phase A).
 *
 * This lib is deliberately framework-free (zod + semver only) so the same
 * validator can be embedded in the `@bge/plugin-toolkit` author CLI (#84)
 * without dragging NestJS or the generated database client along. The
 * `PluginCategory` / scope tuples below are therefore the manifest-side
 * source of truth; `@bge/plugin` asserts bijection with the Prisma enums in
 * a spec so the two surfaces cannot drift silently.
 */

/** Kebab-case, 3–64 chars, must start with a letter. */
export const PLUGIN_SLUG_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;

/**
 * Slugs a plugin may NOT claim : the kebab-cased suffixes of the
 * lifecycle routing keys (`PluginEvent` in `@bge/plugin`). A plugin slugged
 * `installed` would emit under `plugin.installed.*`, making wildcard
 * listeners on the `plugin.` prefix ambiguous between lifecycle traffic and
 * plugin-emitted domain events. Maintained by hand here because this lib is
 * framework-free and `@bge/plugin` depends on it, not vice versa; the drift
 * spec in `@bge/plugin` (`reserved-slugs.spec.ts`) asserts exact equality
 * with the `PluginEvent` vocabulary so the two cannot diverge silently.
 */
export const RESERVED_PLUGIN_SLUGS: ReadonlySet<string> = new Set([
  'installed',
  'enabled',
  'disabled',
  'uninstalled',
  'config-updated',
  'update-check-completed',
  'update-pending',
  'update-approved',
  'update-rejected',
  'load-failed',
  'grant-created',
  'grant-rejected',
  'unit-disabled',
]);

/** Manifest categories — mirrors the Prisma `PluginCategory` enum (bijection spec in `@bge/plugin`). */
export const PLUGIN_CATEGORIES = [
  'data-gateway',
  'notification-channel',
  'storage-driver',
  'media-integration',
  'feedback-sink',
  'analytics-sink',
  'observability',
  'backup-sink',
  'calendar-sync',
  'recommendation-engine',
  'event-hook',
] as const;
export type PluginCategoryValue = (typeof PLUGIN_CATEGORIES)[number];

export const PLUGIN_SCOPES = ['server', 'household'] as const;
export type PluginScopeValue = (typeof PLUGIN_SCOPES)[number];

export const PLUGIN_CONSENT_SCOPES = ['server', 'household', 'user'] as const;
export type PluginConsentScopeValue = (typeof PLUGIN_CONSENT_SCOPES)[number];

export const PLUGIN_EXECUTION_MODES = ['in-process', 'worker'] as const;
export type PluginExecutionModeValue = (typeof PLUGIN_EXECUTION_MODES)[number];

/** Feature / topic / schedule identifier segments: kebab-case. */
export const IDENTIFIER_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Dotted event names: `game.import.completed`. */
export const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/;

/** Subscribe patterns additionally allow a trailing `.*` / `.**` wildcard segment. */
export const EVENT_SUBSCRIBE_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*(\.\*{1,2})?$/;

/** Dotted topic names: `library.sync-completed`. */
export const TOPIC_NAME_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

/** Core model names referenced by `storage.readsCore` / `storage.writesCore` (Prisma model PascalCase). */
export const CORE_MODEL_NAME_PATTERN = /^[A-Z][A-Za-z0-9]*$/;

/** Snake-case remainder after the enforced `plugin_<slug>_` table prefix. */
export const OWN_TABLE_SUFFIX_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Charset guard for cron fields; full parse happens at schedule registration (Phase C). */
export const CRON_FIELD_PATTERN = /^[0-9*,/\-LW?#A-Za-z]+$/;

/** Default minimum trimmed length for a permission request `reason`. */
export const DEFAULT_MIN_REASON_LENGTH = 12;

/**
 * Low-effort reason text rejected regardless of length. Kept intentionally
 * blunt — reason quality beyond this is a registry-review concern (#84),
 * not a validator concern (#60 out-of-scope note).
 */
export const LOW_EFFORT_REASON_PATTERN =
  /^(?:n\/?a|todo|tbd|test(?:ing)?|reason|because|placeholder|lorem(?:\s+ipsum)?.*|x+|\.+|-+)$/i;

/** `$id` stamped on the generated JSON Schema artifact consumed by `bge-plugin validate` (#84). */
export const PLUGIN_MANIFEST_JSON_SCHEMA_ID = 'https://boardgamesempire.dev/schemas/plugin-manifest/v1.json';

/** Prefix helpers keep the namespacing rules in one place. */
export const pluginPermissionPrefix = (slug: string): string => `plugin:${slug}:`;
export const pluginQueuePrefix = (slug: string): string => `plugin:${slug}:`;
export const pluginEmitPrefix = (slug: string): string => `plugin.${slug}.`;
export const pluginTablePrefix = (slug: string): string => `plugin_${slug.replace(/-/g, '_')}_`;
