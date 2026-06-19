/**
 * Code-side quota resource taxonomy. The DB column `Quota.resource` is a plain
 * string; this union is the source of truth for which keys are valid, validated
 * at the API boundary and resolved against the `QuotaResourceRegistry`.
 *
 * Adding a resource is two coordinated edits: a key here + a definition in the
 * registry (and, once a write path can compute usage, a `usage` provider).
 */
export const QUOTA_RESOURCES = [
  'household_member_count',
  'webhook_subscription_count',
  'storage_bytes',
  'plugin_install_count',
] as const;

export type QuotaResource = (typeof QUOTA_RESOURCES)[number];

export function isQuotaResource(value: string): value is QuotaResource {
  return (QUOTA_RESOURCES as readonly string[]).includes(value);
}

/**
 * Sentinel `scopeId` for a type-level default (and the single `Server` row).
 * The DB stores this; the service treats `scopeId === null` as the default at
 * every public surface and maps to/from this value at the DB boundary.
 */
export const DEFAULT_SCOPE_ID = '*';
