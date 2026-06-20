import type { Prisma, ResourceType } from '@bge/database';

/**
 * The subset of `ResourceType` values that correspond to a concrete Prisma model.
 *
 * `ResourceType` is a *superset* of the Prisma model names: alongside the
 * row-backed types (`Household`, `Event`, `Game`, …) it also carries aggregate /
 * synthetic resources that have no backing table — e.g. `System`, `Campaign`,
 * `GameSharing`. Intersecting with `Prisma.ModelName` narrows the union to
 * exactly the values that can index `@casl/prisma`'s `WhereInput<TModelName>`,
 * which lets `AbilityService` return a strictly-typed `WhereInput<TResource>[]`
 * with no cast and no `any`.
 *
 * Consequence (by design): a non-model `ResourceType` such as `ResourceType.System`
 * is NOT assignable here, so `getCurrentResourceConditions(ResourceType.System, …)`
 * is a compile error — those resources aren't row-filterable via `accessibleBy`,
 * and a guard-level `@CheckPolicies` check is the right tool for them instead.
 * Any future `ResourceType` without a matching model likewise drops out of this
 * union and fails to compile at the call site (fail-loud, not silent allow).
 */
export type ModelResourceType = `${ResourceType}` & Prisma.ModelName;
