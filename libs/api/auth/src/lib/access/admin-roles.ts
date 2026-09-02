import { adminAc, defaultAc, userAc } from 'better-auth/plugins/admin/access';

/**
 * Every impersonation statement better-auth defines shares this prefix
 * (`impersonate`, `impersonate-admins`). Matching the family by prefix rather
 * than naming the two means a third variant added upstream is withheld the day
 * it appears rather than silently granted.
 */
const IMPERSONATION_PREFIX = 'impersonate';

/**
 * The admin role's statements: the packaged `adminAc` minus impersonation.
 *
 * Derived rather than transcribed on purpose (#408). `newRole` validates
 * nothing against the access-control definition, so a typo in a hand-written
 * list silently *revokes* a capability with no error anywhere. The cost of
 * deriving is the opposite risk — a statement added by a future better-auth
 * release would be granted silently — and the pinned literal in this module's
 * spec is what turns that into a red build instead.
 *
 * Frozen, and holding its own copies of both arrays, because `authorize()`
 * re-reads `statements[resource]` on every permission check rather than
 * closing over a snapshot: a `push('impersonate')` from anywhere would
 * re-grant impersonation on a running server. The copies also keep the freeze
 * off better-auth's own exported arrays, which are not ours to immobilise.
 */
export const ADMIN_ROLE_STATEMENTS = Object.freeze({
  user: Object.freeze(adminAc.statements.user.filter((action) => !action.startsWith(IMPERSONATION_PREFIX))),
  session: Object.freeze([...adminAc.statements.session]),
});

/**
 * `adminAc` with impersonation withheld.
 *
 * Built from `defaultAc` (the access control over the *full* statement set) so
 * that `authorize({ user: ['impersonate'] })` stays a legal request that comes
 * back denied, rather than an unknown-resource error.
 */
export const adminRoleWithoutImpersonation = defaultAc.newRole(ADMIN_ROLE_STATEMENTS);

/**
 * The role map handed to `admin()`.
 *
 * Overriding `roles` is the whole mechanism of the block:
 * `POST /api/auth/admin/impersonate-user` gates on
 * `permissions: { user: ['impersonate'] }`, and `hasPermission` resolves that
 * against `options.roles || defaultRoles` — so replacing the map denies the
 * route for every principal, including the Owner.
 *
 * `user` keeps the packaged empty role deliberately: provisioning writes
 * `user.role = 'admin'` for the first human only, and everyone else falls to
 * the plugin's `defaultRole` of `'user'`, which must resolve to something that
 * grants nothing.
 */
export const ADMIN_PLUGIN_ROLES = Object.freeze({
  admin: adminRoleWithoutImpersonation,
  user: userAc,
});

/**
 * The complete options object for `admin()`.
 *
 * Exported as a whole rather than spread at the call site so that the
 * load-bearing negative invariant is testable instead of a comment:
 * **`adminUserIds` must never appear here.** `hasPermission` short-circuits
 * `true` for any id in that list *before* consulting the role map, which would
 * void the block entirely — and no end-to-end test can catch it, because a
 * suite's principals are freshly minted random users that would never be on
 * such a list. This module's spec asserts the key's absence.
 */
export const ADMIN_PLUGIN_OPTIONS = Object.freeze({
  roles: ADMIN_PLUGIN_ROLES,
});
