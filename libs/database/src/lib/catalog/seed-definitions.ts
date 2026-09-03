import type { Action, Prisma, ResourceType, RiskLevel, SystemRole } from '../client';

/**
 * One entry in the seeded permission catalog.
 *
 * `riskLevel` is REQUIRED at the type level: the compiler — not a runtime
 * check — guarantees that no seeded permission relies on the schema default
 * (#60). Omitting a classification on a new entry fails the build. The
 * `@default(Low)` on the Prisma column exists only for rows created outside
 * this catalog (plugin-declared permissions; their classification is decided
 * in #59 Phase C).
 *
 * The catalog is declared `as const`, so every array-valued member is
 * `readonly` here: a mutable `string[]` would reject the literal tuples the
 * declaration produces. Prisma's own JSON input types are already readonly.
 */
export interface PermissionSeedDefinition {
  action: Action;

  /**
   * ResourceType for domain permissions; literal 'all' for the global wildcards.
   */
  subject: ResourceType | 'all';

  /**
   * Stable code-side identifier, e.g. 'read:game'.
   */
  slug: string;

  /**
   * Consent-surface risk classification (#60 canonical rubric).
   */
  riskLevel: RiskLevel;

  reason: string;

  /**
   * Mustache-templated ABAC conditions, rendered by the ability factory.
   */
  conditions?: Prisma.InputJsonObject;

  fields?: readonly string[];
}

/**
 * One entry in the seeded role catalog. Every seeded role is a system role
 * (`Role.isSystem = true`); custom roles (#169) are not catalog rows.
 */
export interface RoleSeedDefinition {
  name: SystemRole;
  description: string;
}

/**
 * Which `AbilityFactory.createForUser` pass a role's permissions arrive
 * through, and therefore which scope coordinate its condition templates can
 * bind to: `global` roles render with `{ user, role }` only, `household`
 * roles add `householdId`, `event` roles add `eventId`.
 *
 * Classified by an explicit map (`ROLE_SCOPE`) rather than by name prefix so
 * a future role that breaks the naming convention cannot silently opt out of
 * the checks that depend on this (#234). `Role.scopeLevel` (#429) is the
 * durable form; when it lands this map becomes its seed input.
 */
export type RoleScope = 'global' | 'household' | 'event';
