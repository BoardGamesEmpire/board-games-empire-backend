import { adminAc, defaultStatements, userAc } from 'better-auth/plugins/admin/access';
import {
  ADMIN_PLUGIN_OPTIONS,
  ADMIN_PLUGIN_ROLES,
  ADMIN_ROLE_STATEMENTS,
  adminRoleWithoutImpersonation,
} from './admin-roles';

const IMPERSONATION = defaultStatements.user.filter((action) => action.startsWith('impersonate'));

/**
 * The impersonation block (#408). These specs pin the role map itself; the
 * wire behaviour — that `admin()` actually receives this map — is asserted by
 * the e2e in `apps/api-e2e/src/auth`, because a spec over these constants
 * still passes if someone drops the options at the `admin()` call site.
 */
describe('admin plugin role map', () => {
  it('has impersonation statements to withhold in the first place', () => {
    // Guards every assertion below: if upstream renamed the family, the
    // prefix filter silently withholds nothing and this fails first.
    expect(IMPERSONATION).toEqual(['impersonate', 'impersonate-admins']);
  });

  describe('the derived admin role', () => {
    it.each(IMPERSONATION)('denies user:%s', (action) => {
      // `authorize` is typed against the full statement set, so a withheld
      // action is a legal request that must come back denied.
      const decision = adminRoleWithoutImpersonation.authorize({ user: [action] });

      expect(decision.success).toBe(false);
    });

    it.each(ADMIN_ROLE_STATEMENTS.user)('still grants user:%s', (action) => {
      expect(adminRoleWithoutImpersonation.authorize({ user: [action] }).success).toBe(true);
    });

    it.each(ADMIN_ROLE_STATEMENTS.session)('still grants session:%s', (action) => {
      expect(adminRoleWithoutImpersonation.authorize({ session: [action] }).success).toBe(true);
    });
  });

  /**
   * D-408-1: the statement list is derived from `adminAc` by subtraction, so a
   * typo cannot silently revoke a capability. The cost of deriving is that a
   * statement added by a future better-auth release would be granted
   * silently — this literal is what turns that into a red build.
   */
  describe('the pinned statement set', () => {
    it('is exactly the expected set', () => {
      expect(ADMIN_ROLE_STATEMENTS).toEqual({
        user: ['create', 'list', 'set-role', 'ban', 'delete', 'set-password', 'set-email', 'get', 'update'],
        session: ['list', 'revoke', 'delete'],
      });
    });

    it('grants not one impersonation statement', () => {
      // An intersection-is-empty check, NOT
      // `.not.toEqual(expect.arrayContaining(IMPERSONATION))` — that negation
      // is satisfied by any one member being absent, so it passes while
      // `impersonate` is still granted.
      const leaked = ADMIN_ROLE_STATEMENTS.user.filter((action) =>
        (IMPERSONATION as readonly string[]).includes(action),
      );

      expect(leaked).toEqual([]);
    });

    it('differs from the packaged admin role by impersonation and nothing else', () => {
      const withheld = adminAc.statements.user.filter(
        (action) => !(ADMIN_ROLE_STATEMENTS.user as readonly string[]).includes(action),
      );

      expect(withheld).toEqual(['impersonate']);
    });

    it('keeps the session statements upstream defines', () => {
      // A structural comparison only because the module copies the array;
      // the object spread it used to rely on aliased upstream's own array,
      // which made this assertion compare a value with itself.
      expect(ADMIN_ROLE_STATEMENTS.session).not.toBe(adminAc.statements.session);
      expect(ADMIN_ROLE_STATEMENTS.session).toEqual([...adminAc.statements.session]);
    });
  });

  /**
   * `authorize()` re-reads `statements[resource]` on every call instead of
   * closing over a snapshot, so a mutation of the exported arrays would
   * re-grant impersonation on a running server.
   */
  describe('immutability', () => {
    it('refuses a mutation that would re-grant impersonation', () => {
      expect(() => (ADMIN_ROLE_STATEMENTS.user as string[]).push('impersonate')).toThrow(TypeError);
      expect(adminRoleWithoutImpersonation.authorize({ user: ['impersonate'] }).success).toBe(false);
    });

    it('refuses a swap of the admin role itself', () => {
      expect(() => {
        (ADMIN_PLUGIN_ROLES as { admin: unknown }).admin = userAc;
      }).toThrow(TypeError);
    });
  });

  describe('the options handed to admin()', () => {
    it('carries exactly the admin and user roles', () => {
      expect(Object.keys(ADMIN_PLUGIN_ROLES).sort()).toEqual(['admin', 'user']);
    });

    /**
     * The one invariant no end-to-end test can cover: `hasPermission` returns
     * `true` for any id in `adminUserIds` before it ever consults the role
     * map, and a suite's principals are freshly minted random users who would
     * not appear on such a list. Adding the key voids the whole block, so its
     * absence is asserted here rather than left to a comment.
     */
    it('does not pass adminUserIds, which would short-circuit the role map', () => {
      expect(Object.keys(ADMIN_PLUGIN_OPTIONS)).toEqual(['roles']);
      expect('adminUserIds' in ADMIN_PLUGIN_OPTIONS).toBe(false);
    });

    it('leaves the packaged empty user role in place', () => {
      expect(ADMIN_PLUGIN_ROLES.user).toBe(userAc);
      expect(ADMIN_PLUGIN_ROLES.user.authorize({ user: ['impersonate'] }).success).toBe(false);
      expect(ADMIN_PLUGIN_ROLES.user.authorize({ user: ['list'] }).success).toBe(false);
    });
  });
});
