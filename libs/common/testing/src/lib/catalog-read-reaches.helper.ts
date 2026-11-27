import type { ReadReach } from '@bge/database';
import {
  deriveReadCeilings,
  isAttendanceOnly,
  PERMISSION_CATALOG,
  ResourceType,
  ROLE_PERMISSION_CATALOG,
} from '@bge/database';

/**
 * Every reach the shipped catalog grants on `subject`: each role's read of it,
 * plus the wildcard reads under `all`, which reach it too. They don't reach an
 * attendance-only type: the ability factory denies those to every pass but the
 * event roles', so a wildcard read of one grants nothing (#1543).
 *
 * For the lists declared `Unscoped` because only staff read them, each over
 * every row. That reason is a claim about the catalog, and the catalog's own
 * pin (`known-read-ceilings.spec.ts`) does not know which lists rest on it. A
 * spec beside the declaration asserts this is only `'every row'`, so a
 * conditioned read granted later fails where the claim is made. Catalog roles
 * only, like `deriveReadCeilings`: direct and API-key grants are runtime rows.
 */
export function shippedReadReaches(subject: ResourceType): ReadReach[] {
  const ceilings = deriveReadCeilings(PERMISSION_CATALOG, ROLE_PERMISSION_CATALOG, [
    'all',
    ...Object.values(ResourceType),
  ]);

  const reaching = isAttendanceOnly(subject) ? [ceilings[subject]] : [ceilings['all'], ceilings[subject]];

  return reaching.flatMap((byRole) => Object.values(byRole).flatMap((bySlug) => Object.values(bySlug)));
}
