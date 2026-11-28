import type { Permission, RiskLevel } from '@bge/database';
import { Action, isAttendanceOnly, ResourceType } from '@bge/database';
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
 *
 * `GameCollection` joined when the add checked the row it writes: a new entry
 * against `create`, an entry the user already has against `update`, so a key
 * pinned to one entry adds no other (#1288). Its reads, updates and removals
 * take a pin through the route. Its create pin stays refused there, by
 * {@link acceptsPin}, since no entry exists yet to pin.
 */
export const API_KEY_PINNABLE_TYPES: ReadonlySet<ResourceType> = new Set<ResourceType>([
  ResourceType.GameCollection,
  ResourceType.Job,
  ResourceType.WebhookSubscription,
  ResourceType.User,
  ResourceType.Notification,
  ResourceType.Plugin,
  ResourceType.HouseholdBan,
]);

/**
 * The types a `manage` permission may be pinned to. `manage` covers create, and
 * a create route that checks only the type lets a pinned `manage` key through,
 * so a type joins only when its create route checks the pinned row. Webhook
 * subscriptions do. `Plugin` stays off: its artifact upload routes check the
 * type alone, so a pinned `manage:plugin` key could upload. #1366 re-admits it
 * once they check the pin (#1418).
 */
export const API_KEY_MANAGE_PINNABLE_TYPES: ReadonlySet<ResourceType> = new Set<ResourceType>([
  ResourceType.WebhookSubscription,
]);

/**
 * Whether a key scope over `permission` accepts a pinned row. It refuses a
 * `create` permission, since no row exists yet to pin (#1417), and a `manage`
 * permission unless its type is in {@link API_KEY_MANAGE_PINNABLE_TYPES},
 * because `manage` covers create. Any other action accepts a pin on a type in
 * {@link API_KEY_PINNABLE_TYPES} (#1418).
 */
export function acceptsPin(permission: Pick<Permission, 'action' | 'subject'>): boolean {
  const pinnable: ReadonlySet<string> = API_KEY_PINNABLE_TYPES;
  const managePinnable: ReadonlySet<string> = API_KEY_MANAGE_PINNABLE_TYPES;

  if (permission.action === Action.create) {
    return false;
  }

  if (permission.action === Action.manage && !managePinnable.has(permission.subject)) {
    return false;
  }

  return pinnable.has(permission.subject);
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
 * - its subject isn't `all`: a key scope over it would reach every type, and no
 *   pin can narrow it (#1418);
 * - its subject isn't an attendance-only resource type, such as an event chat's
 *   messages: only event attendance grants those, and a key attends nothing,
 *   whatever its owner attends (#1543);
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
 * too. So is the `all` check: the factory still builds an allow from an
 * existing `all`-subject scope row, and create and edit refuse such slugs. The
 * attendance-only check has the factory behind it: every key's ability denies
 * those types after its allows, so a key scope over one reaches nothing. Risk
 * excludes nothing.
 */
export function mayKeyHold(owner: UserWithRoles, permissionId: string): boolean {
  return firstGrantableContext(owner, permissionId, Date.now()) !== undefined;
}

/**
 * The first context where the owner holds `permissionId` and a key scope over
 * it builds an allow. {@link renderHeldAllow} refuses a denial and a condition
 * the context can't resolve, exactly as the factory does (#1417). A permission
 * on `all` never qualifies (#1418), nor does a context whose rule would be on
 * an attendance-only resource type (#1543), so the list and {@link mayKeyHold}
 * share both rules. The type tested is the rule's subject, `held.subject`: a
 * direct permission's rule is on its row's `resourceType`, the type
 * {@link buildsDirectPermissionRule} tests, and the key's rule is built there
 * too.
 */
function firstGrantableContext(owner: UserWithRoles, permissionId: string, now: number): HoldingContext | undefined {
  return holdingContexts(owner, permissionId, now).find(
    (held) =>
      held.permission.retiredAt == null &&
      held.permission.subject !== 'all' &&
      !isAttendanceOnly(held.subject) &&
      !('refusal' in renderHeldAllow(held)),
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
