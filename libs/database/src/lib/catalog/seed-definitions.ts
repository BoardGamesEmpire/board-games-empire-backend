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
 * Every array-valued member is `readonly`: `permission()` types `fields` as a
 * readonly array and Prisma's own JSON input types are already readonly, so a
 * mutable `string[]` here would reject both.
 *
 * This is the shape every consumer reads. The catalog itself is written
 * through `permission()` (`permission-entry.ts`), which types `conditions`
 * and `fields` by the entry's `subject` while the file compiles and returns
 * this interface (#234).
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
   * Mustache-templated ABAC conditions, rendered by the ability factory. A
   * Prisma `where` clause for `subject` with placeholders in its values;
   * `permission()` checks the paths against the subject's `WhereInput`, and
   * `assertJsonConditions` that every value is JSON as written.
   */
  conditions?: Prisma.InputJsonObject;

  /**
   * Scalar columns of `subject` the grant is limited to; `permission()`
   * checks each against the subject's scalar-field enum.
   */
  fields?: readonly string[];
}

/**
 * One entry in the seeded role catalog. Every seeded role is written as
 * `managedBy: System` (#235); custom roles (#169) are not catalog rows, and
 * the reconciler leaves any role it does not own alone.
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
