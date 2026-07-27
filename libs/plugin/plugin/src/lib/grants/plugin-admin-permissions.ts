/**
 * Plugin-administration permission slugs: `manage:plugin` and every
 * `manage:plugin:*` descendant. Seeded in Phase C4 for the consent
 * endpoints' guards; matched here by PATTERN so the hard exclusion below
 * cannot depend on seed rows existing.
 */
export const PLUGIN_ADMIN_PERMISSION_SLUG_PATTERN = /^manage:plugin(?::|$)/;

/**
 * The hard-exclusion predicate: a plugin principal may NEVER be granted a
 * plugin-administration slug. Whoever holds `manage:plugin*` decides which
 * principals get which authority — a plugin approving grants for plugins
 * (or a future version of itself) is a self-escalation loop, so
 * this is a service-level refusal in `PluginGrantService`, not a
 * consent-surface warning. Same philosophy as the `'all'`-wildcard
 * never-directly-assignable rule in `AbilityFactory`.
 */
export const isPluginAdministrationSlug = (slug: string): boolean => PLUGIN_ADMIN_PERMISSION_SLUG_PATTERN.test(slug);
