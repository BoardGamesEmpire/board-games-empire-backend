import type { Permission, PermissionSeedDefinition, PermissionSlug, Prisma } from '@bge/database';
import { Action, PERMISSION_CATALOG, PermissionOwner, RiskLevel } from '@bge/database';
import { sequence } from './sequence.js';

export function makePermission(overrides: Partial<Permission> = {}): Permission {
  const n = sequence();
  return {
    id: `perm-${n}`,
    action: Action.read,
    subject: 'Game',
    riskLevel: RiskLevel.Low,
    fields: [],
    conditions: null,
    inverted: false,
    reason: null,
    slug: `read:game:${n}`,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    managedBy: PermissionOwner.System,
    retiredAt: null,
    ...overrides,
  };
}

/**
 * A `Permission` row built from the shipped catalog entry for `slug`, so a
 * spec exercises the condition template that actually seeds rather than a
 * copy of it. Conditions go through a JSON round-trip only to turn the
 * readonly `Prisma.InputJsonObject` the catalog carries into the plain
 * `JsonValue` a `Permission` row does; the factory never mutates what it
 * renders.
 */
export function catalogPermission(slug: PermissionSlug): Permission {
  const catalog: readonly PermissionSeedDefinition[] = PERMISSION_CATALOG;
  const entry = catalog.find((definition) => definition.slug === slug);
  if (!entry) {
    throw new Error(`PERMISSION_CATALOG has no entry for '${slug}'`);
  }

  return makePermission({
    action: entry.action,
    subject: entry.subject,
    slug: entry.slug,
    riskLevel: entry.riskLevel,
    reason: entry.reason,
    fields: [...(entry.fields ?? [])],
    conditions: JSON.parse(JSON.stringify(entry.conditions ?? {})),
  });
}

/** A subject and conditions for a rule row, to spread into `makePermission`. */
interface UnitRule {
  readonly subject: string;
  readonly conditions: Prisma.JsonObject;
}

/**
 * Conditions that bind each consent unit: its id on a real id column (#994).
 * Keyed by the `PluginGrantScope` values, so a decision's consent scope indexes them.
 */
export const UNIT_BOUND_RULES: Readonly<Record<'Household' | 'User', UnitRule>> = {
  Household: { subject: 'Event', conditions: { householdId: '{{ unit.householdId }}' } },
  User: { subject: 'GameCollection', conditions: { userId: '{{ unit.userId }}' } },
};

/**
 * The consent unit's id on a field that holds no unit id, directly and through
 * a relation (#994). Every consent seam must refuse each of these.
 */
export const UNIT_ID_OFF_ID_COLUMN_RULES: Readonly<
  Record<'Household' | 'User', readonly (UnitRule & { readonly label: string })[]>
> = {
  Household: [
    { label: 'a text field', subject: 'Event', conditions: { title: '{{ unit.householdId }}' } },
    {
      label: 'a text field through is',
      subject: 'Event',
      conditions: { household: { is: { name: '{{ unit.householdId }}' } } },
    },
  ],
  User: [
    { label: 'a text field', subject: 'Household', conditions: { name: '{{ unit.userId }}' } },
    {
      label: 'a text field through some',
      subject: 'Household',
      conditions: { members: { some: { user: { is: { username: '{{ unit.userId }}' } } } } },
    },
  ],
};
