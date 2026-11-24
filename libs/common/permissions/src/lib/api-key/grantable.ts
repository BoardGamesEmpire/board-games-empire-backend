import type { Permission, RiskLevel } from '@bge/database';
import { Action, ResourceType } from '@bge/database';
import type { UserWithRoles } from '../interfaces';
import type { HoldingContext } from './holding-contexts';
import { holdingContexts } from './holding-contexts';
import { renderHeldAllow } from './key-scope-render';

/**
 * The resource types a key scope may be pinned to: those whose routes hold a
 * key to its pin today. A type joins when its routes are fixed and an e2e
 * covers the pin; household lists that answer 403 to a pinned key stay off it,
 * and so does `HouseholdPlugin`, whose routes check `householdId` and would
 * make a pinned key work nowhere (#1417, #266).
 */
export const API_KEY_PINNABLE_TYPES: ReadonlySet<ResourceType> = new Set<ResourceType>([
  ResourceType.Job,
  ResourceType.WebhookSubscription,
  ResourceType.User,
  ResourceType.Notification,
  ResourceType.Plugin,
  ResourceType.HouseholdBan,
]);

/**
 * A pin is accepted on an allowlisted type, never on a create permission: no
 * row exists yet to pin (#1417). A `manage` permission still accepts one, and
 * `manage` covers create, so a pinned `manage` scope does not stop a create
 * route that checks only the type. The key create route (#1418) must refuse
 * that pairing.
 */
export function acceptsPin(permission: Pick<Permission, 'action' | 'subject'>): boolean {
  const pinnable: ReadonlySet<string> = API_KEY_PINNABLE_TYPES;

  return permission.action !== Action.create && pinnable.has(permission.subject);
}

/** One permission an owner's API key may hold, as the key's create screen lists it (#1417). */
export interface GrantablePermission {
  readonly id: string;

  /** Whether a key scope over it accepts a pinned row ({@link acceptsPin}). */
  readonly pinnable: boolean;

  /** Adds friction at create (a `Critical` one needs a fresh session and a confirmation); excludes nothing. */
  readonly riskLevel: RiskLevel;

  readonly slug: string;
}

/**
 * One entry per permission the owner's key may hold, deduped by id, sorted by
 * slug (#1417). A key is always judged by its owner's ability and its own
 * together, so this is what the create screen offers, not a safety boundary.
 * See {@link mayKeyHold} for the rule.
 */
export function grantablePermissions(owner: UserWithRoles): GrantablePermission[] {
  const now = Date.now();
  const grantable: GrantablePermission[] = [];

  for (const permissionId of heldPermissionIds(owner)) {
    const held = firstGrantableContext(owner, permissionId, now);

    if (held) {
      const { id, slug, riskLevel } = held.permission;
      grantable.push({ id, slug, riskLevel, pinnable: acceptsPin(held.permission) });
    }
  }

  return grantable.sort((a, b) => compareCodePoints(a.slug, b.slug));
}

/**
 * Whether the owner's key may hold `permissionId`, for #1418's create and
 * edit (#1417). A key may hold a permission when all of these hold:
 *
 * - it is an allow: a denial is refused for now;
 * - it isn't retired (the loader already leaves retired rows out; a stale
 *   cached graph must not bring one back);
 * - it renders in at least one context where its owner holds it, with every
 *   variable resolved. A household permission held through a membership
 *   qualifies; a direct permission whose condition names `{{ householdId }}`
 *   doesn't, because a direct permission renders with the user alone.
 *
 * The render check is the one `AbilityFactory.createForApiKey` makes, so the
 * list and the factory agree on which contexts build. The retirement check is
 * the list's alone: the loaders drop retired rows, so the factory meets one
 * only in a stale cached graph, where the owner's own ability still holds it
 * too. Risk excludes nothing.
 */
export function mayKeyHold(owner: UserWithRoles, permissionId: string): boolean {
  return firstGrantableContext(owner, permissionId, Date.now()) !== undefined;
}

/**
 * The first context where the owner holds `permissionId` and a key scope over
 * it builds an allow. {@link renderHeldAllow} refuses a denial and a condition
 * the context can't resolve, exactly as the factory does (#1417).
 */
function firstGrantableContext(owner: UserWithRoles, permissionId: string, now: number): HoldingContext | undefined {
  return holdingContexts(owner, permissionId, now).find(
    (held) => held.permission.retiredAt == null && !('refusal' in renderHeldAllow(held)),
  );
}

/** Each permission id anywhere in the owner's graph, held or not; {@link holdingContexts} decides which count. */
function heldPermissionIds(owner: UserWithRoles): Set<string> {
  const roles = [
    ...owner.roles.map(({ role }) => role),
    ...owner.householdMember.map((member) => member.role?.role),
    ...owner.eventsAttended.map((attendee) => attendee.role?.role),
  ];

  return new Set([
    ...roles.flatMap((role) => role?.permissions.map(({ permission }) => permission.id) ?? []),
    ...owner.permissions.map(({ permission }) => permission.id),
  ]);
}

/** Code-point order, so the list's order doesn't follow the server's locale. */
function compareCodePoints(a: string, b: string): number {
  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
}
