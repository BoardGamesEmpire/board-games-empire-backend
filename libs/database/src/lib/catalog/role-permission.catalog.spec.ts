import { SystemRole } from '../client';
import { PERMISSION_CATALOG } from './permission.catalog';
import { ROLE_PERMISSION_CATALOG } from './role-permission.catalog';
import { ROLE_CATALOG, ROLE_SCOPE } from './role.catalog';

// Importing the catalog modules IS the positive integrity case: each runs its
// assertions at module scope, so a shipped catalog that violated one would fail
// this file at import. The negative cases live in catalog-integrity.spec.ts.
describe('the shipped catalogs', () => {
  it('seed every SystemRole exactly once, and assign and classify every one of them', () => {
    const systemRoles = Object.values(SystemRole).sort();

    expect(ROLE_CATALOG.map((role) => role.name).sort()).toEqual(systemRoles);
    expect(Object.keys(ROLE_PERMISSION_CATALOG).sort()).toEqual(systemRoles);
    expect(Object.keys(ROLE_SCOPE).sort()).toEqual(systemRoles);
  });

  it('classify the household and event roles as scoped, everything else as global', () => {
    const scoped = Object.entries(ROLE_SCOPE)
      .filter(([, scope]) => scope !== 'global')
      .map(([role]) => role)
      .sort();

    expect(scoped).toEqual(
      [
        SystemRole.HouseholdOwner,
        SystemRole.HouseholdAdmin,
        SystemRole.HouseholdMember,
        SystemRole.HouseholdGuest,
        SystemRole.EventHost,
        SystemRole.EventCoHost,
        SystemRole.EventOrganizer,
        SystemRole.EventModerator,
        SystemRole.EventParticipant,
        SystemRole.EventGuest,
        SystemRole.EventSpectator,
      ].sort(),
    );
  });

  it('bind every template placeholder to an identifier column', () => {
    // Every render-context variable is an identifier — `user.id`, `householdId`,
    // `eventId` — and the compiler cannot tell a placeholder from any other
    // string where a column accepts strings (DateTime, Decimal, Json). So a
    // placeholder belongs under an identifier column and nowhere else: the
    // runtime tripwire for the value-type gap the typed catalog leaves (#234).
    // The column is the nearest enclosing key that is not a Prisma operator,
    // so `id: { equals: … }` is judged by `id`, `createdAt: { in: [ … ] }` by
    // `createdAt`, and a string inside an operator's array is judged too.
    const operators = new Set([
      ...['AND', 'OR', 'NOT'],
      ...['some', 'none', 'every', 'is', 'isNot'],
      ...[
        'equals',
        'in',
        'notIn',
        'not',
        'lt',
        'lte',
        'gt',
        'gte',
        'contains',
        'startsWith',
        'endsWith',
        'search',
        'mode',
      ],
      ...['has', 'hasEvery', 'hasSome', 'isEmpty'],
    ]);
    const isIdentifier = (column: string | undefined): boolean => column === 'id' || column?.endsWith('Id') === true;
    const misplaced: string[] = [];
    const walk = (slug: string, node: unknown, path: string, column: string | undefined): void => {
      if (typeof node === 'string') {
        if (node.includes('{{') && !isIdentifier(column)) {
          misplaced.push(`${slug}: ${path}`);
        }
        return;
      }

      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(slug, item, `${path}[${index}]`, column));
        return;
      }

      if (node === null || typeof node !== 'object') {
        return;
      }

      for (const [key, value] of Object.entries(node)) {
        walk(slug, value, path === '' ? key : `${path}.${key}`, operators.has(key) ? column : key);
      }
    };

    for (const { slug, conditions } of PERMISSION_CATALOG) {
      walk(slug, conditions, '', undefined);
    }

    expect(misplaced).toEqual([]);
  });

  describe('role lists', () => {
    it('grant Owner exactly the wildcard', () => {
      expect(ROLE_PERMISSION_CATALOG[SystemRole.Owner]).toEqual(['manage:all']);
    });

    it('grant AnonymousUser the Public collection read and nothing else', () => {
      // Anyone who opens an anonymous session holds this role, so the list grows
      // one consumer at a time, each driven through its route (#484). Pinned
      // exactly, so an addition is an edit someone makes here on purpose rather
      // than a line that arrives unread. A guest's event rights are not here:
      // they come from the event role on the guest's attendee row.
      expect(ROLE_PERMISSION_CATALOG[SystemRole.AnonymousUser]).toEqual(['read:game_collection:public']);
    });

    it('enumerate Admin rather than deriving it from the catalog', () => {
      const admin = ROLE_PERMISSION_CATALOG[SystemRole.Admin];

      expect(admin).not.toContain('manage:all');

      // The point of enumerating (#244): a new catalog slug reaches Admin only
      // when someone adds it here. The derivation it replaced handed over every
      // slug but one, 77 of them templated on a household or event that Admin's
      // render pass never supplies, so they were inert and nothing said so.
      expect(admin.length).toBeLessThan(PERMISSION_CATALOG.length - 1);

      expect(admin).toEqual(
        expect.arrayContaining(['manage:household_member:administer', 'delete:household:administer']),
      );
    });

    it.each([SystemRole.Admin, SystemRole.Moderator])('give %s no slug bound to a scope it has none of', (roleName) => {
      const conditioned = ROLE_PERMISSION_CATALOG[roleName]
        .map((slug) => PERMISSION_CATALOG.find((permission) => permission.slug === slug))
        .filter((permission) => Object.keys(permission?.conditions ?? {}).length > 0)
        .map((permission) => permission?.slug);

      // A global role arrives through the `roles` pass, which supplies `user`
      // and `role` and nothing else. So a condition on a staff role is one of
      // exactly two things, and neither belongs: templated on `householdId` or
      // `eventId`, it renders to `''` and matches no row; templated on
      // `user.id`, it grants what the actor's own household or event role
      // already grants, because that role's condition renders identically.
      // Both were shipped and both are gone (#244) — `create:household_role`
      // duplicated `HouseholdOwner`/`HouseholdAdmin`, `delete:event`
      // duplicated `EventHost`, which an event's creator always is.
      //
      // Listed rather than counted, so a failure names the slug.
      expect(conditioned).toEqual([]);
    });

    it.each([SystemRole.Admin, SystemRole.Moderator])('give %s nothing an ordinary User already holds', (roleName) => {
      const user = new Set(ROLE_PERMISSION_CATALOG[SystemRole.User]);
      const shared = ROLE_PERMISSION_CATALOG[roleName].filter((slug) => user.has(slug));

      // Staff AUGMENT `User` rather than mirroring it. Every signed-in actor is
      // provisioned with `User` and elevation adds a role, so a repeated slug
      // grants nothing and only obscures what staff authority actually is.
      // Listed rather than counted, so a failure names the slug to remove —
      // and the fix is removing it from the staff role, not from `User`.
      expect(shared).toEqual([]);
    });

    it('leaves the createdById-scoped game grants to User, where every creator gets them', () => {
      // An imported game is always public and server-owned; a user-created one
      // may be private and is its creator's to edit or delete. `Admin` curates
      // the install through the unconditioned pair, which subsumes these.
      expect(ROLE_PERMISSION_CATALOG[SystemRole.User]).toEqual(
        expect.arrayContaining(['update:game:own', 'delete:game:own']),
      );
      expect(ROLE_PERMISSION_CATALOG[SystemRole.Admin]).toEqual(expect.arrayContaining(['update:game', 'delete:game']));

      for (const roleName of [SystemRole.Admin, SystemRole.Moderator]) {
        expect(ROLE_PERMISSION_CATALOG[roleName]).not.toContain('update:game:own');
        expect(ROLE_PERMISSION_CATALOG[roleName]).not.toContain('delete:game:own');
      }
    });

    it('let User read its own games and everyone’s Public ones, and nothing else', () => {
      const conditionsOf = (slug: string) => PERMISSION_CATALOG.find((entry) => entry.slug === slug)?.conditions;

      // `User` is held by every signed-in actor, so an unconditioned read here
      // is every private game handed to everyone (#472). Pinned exactly rather
      // than by shape, so a clause that goes missing fails here instead of
      // widening the read unnoticed.
      expect(conditionsOf('read:game')).toStrictEqual({ deletedAt: null, createdById: '{{ user.id }}' });
      expect(conditionsOf('read:game:public')).toStrictEqual({ deletedAt: null, visibility: 'Public' });
      expect(ROLE_PERMISSION_CATALOG[SystemRole.User]).toEqual(
        expect.arrayContaining(['read:game', 'read:game:public']),
      );
    });

    it.each(
      Object.entries(ROLE_SCOPE)
        .filter(([, scope]) => scope !== 'global')
        .map(([roleName]) => roleName as SystemRole),
    )('give %s nothing User already holds', (roleName) => {
      // Every signed-in user's ability includes `User`, so a scoped role's copy
      // of one of its slugs grants nothing. Where the condition names the actor,
      // the copy repeats `User`'s clause once per membership or attendance in
      // that ceiling. An anonymous guest's ability does not include `User`;
      // what a guest's event role needs is #488's to decide.
      const userSlugs = ROLE_PERMISSION_CATALOG[SystemRole.User];

      expect(ROLE_PERMISSION_CATALOG[roleName].filter((slug) => userSlugs.includes(slug))).toEqual([]);
    });

    it('give the staff roles no wildcard beyond the read-only one — `manage` on `all` is Owner alone', () => {
      const wildcards = PERMISSION_CATALOG.filter(({ subject }) => subject === 'all').map(({ slug }) => slug);
      const heldBy = (role: SystemRole) => ROLE_PERMISSION_CATALOG[role].filter((slug) => wildcards.includes(slug));

      expect(wildcards).toEqual(['manage:all', 'read:public_content']);
      expect(heldBy(SystemRole.Admin)).toEqual(['read:public_content']);
      expect(heldBy(SystemRole.Moderator)).toEqual(['read:public_content']);
    });

    it('derive HouseholdAdmin from HouseholdOwner minus deletion and the ownership-transfer gate', () => {
      const owner = ROLE_PERMISSION_CATALOG[SystemRole.HouseholdOwner];
      const admin = ROLE_PERMISSION_CATALOG[SystemRole.HouseholdAdmin];

      expect(admin).not.toContain('delete:household');
      expect(admin).not.toContain('update:household_role:transfer-ownership');
      expect(owner.filter((slug) => !admin.includes(slug))).toEqual([
        'delete:household',
        'update:household_role:transfer-ownership',
      ]);
    });

    it('derive EventCoHost from EventHost minus event deletion only', () => {
      const host = ROLE_PERMISSION_CATALOG[SystemRole.EventHost];
      const coHost = ROLE_PERMISSION_CATALOG[SystemRole.EventCoHost];

      expect(host.filter((slug) => !coHost.includes(slug))).toEqual(['delete:event']);
    });
  });
});
