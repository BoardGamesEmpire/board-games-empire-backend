import { Action, Reach, ResourceType, RiskLevel, SystemRole } from '../client';
import { parseTemplate } from './catalog-guards';
import { PERMISSION_CATALOG } from './permission.catalog';
import { ROLE_PERMISSION_CATALOG } from './role-permission.catalog';
import { ROLE_CATALOG, ROLE_SCOPE } from './role.catalog';

/**
 * "An accepted friend of the acting user", as a friends rule binds it, written
 * out here rather than taken from the helper the catalog builds it with, so a
 * change to that helper fails this file.
 */
const ACCEPTED_FRIEND_OF_ACTING_USER = {
  OR: [
    { friendshipsRequested: { some: { addresseeId: '{{ user.id }}', status: 'Accepted' } } },
    { friendshipsReceived: { some: { requesterId: '{{ user.id }}', status: 'Accepted' } } },
  ],
};

/**
 * "A block between this User node and the acting user, whichever placed it",
 * as the friends-of-friends rules and the share rule veto it (#496, #810).
 * Written out for the reason `ACCEPTED_FRIEND_OF_ACTING_USER` is.
 */
const BLOCK_WITH_ACTING_USER = {
  OR: [
    { friendshipsRequested: { some: { addresseeId: '{{ user.id }}', status: 'Blocked' } } },
    { friendshipsReceived: { some: { requesterId: '{{ user.id }}', status: 'Blocked' } } },
  ],
};

/**
 * "A friend of a friend of the acting user, with no block between them", as a
 * friends-of-friends rule binds it (#496). Written out for the reason
 * `ACCEPTED_FRIEND_OF_ACTING_USER` is.
 */
const FRIEND_OF_FRIEND_OF_ACTING_USER = {
  OR: [
    { friendshipsRequested: { some: { status: 'Accepted', addressee: { is: ACCEPTED_FRIEND_OF_ACTING_USER } } } },
    { friendshipsReceived: { some: { status: 'Accepted', requester: { is: ACCEPTED_FRIEND_OF_ACTING_USER } } } },
  ],
  NOT: BLOCK_WITH_ACTING_USER,
};

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
        expect.arrayContaining([
          'manage:household_member:administer',
          'delete:household:administer',
          'update:household:restore:administer',
        ]),
      );
    });

    it.each([SystemRole.Admin, SystemRole.Moderator])('give %s no slug bound to a scope it has none of', (roleName) => {
      const templated = ROLE_PERMISSION_CATALOG[roleName]
        .map((slug) => PERMISSION_CATALOG.find((permission) => permission.slug === slug))
        .filter((permission) => parseTemplate(permission?.conditions).variables.length > 0)
        .map((permission) => permission?.slug);

      // A global role arrives through the `roles` pass, which supplies `user`
      // and `role` and nothing else. So a TEMPLATED condition on a staff role
      // is one of exactly two things, and neither belongs: templated on
      // `householdId` or `eventId`, it renders to `''` and matches no row;
      // templated on `user.id`, it grants what the actor's own household or
      // event role already grants, because that role's condition renders
      // identically. Both were shipped and both are gone (#244) —
      // `create:household_role` duplicated `HouseholdOwner`/`HouseholdAdmin`,
      // and `delete:event`, then scoped to the event's creator, duplicated
      // `EventHost`, which an event's creator always is. Both have moved on
      // since: the first is gone (#168), and the second binds to the event's
      // host (#567).
      //
      // A STATIC condition is neither. It references no variable, so it
      // renders the same in every pass, and it narrows an otherwise
      // install-wide grant: the case below is the one that exists.
      //
      // Listed rather than counted, so a failure names the slug.
      expect(templated).toEqual([]);
    });

    it.each([
      [SystemRole.Admin, ['update:household:restore:administer']],
      [SystemRole.Moderator, []],
    ])('give %s exactly the static conditions it is meant to, and no more', (roleName, expected) => {
      // The case above admits static conditions by shape, so this is what
      // stops a second one arriving unread: a static condition still reaches
      // every row it matches on the install. Named, so adding one is an edit
      // made here on purpose.
      const conditionsOf = (slug: string) =>
        PERMISSION_CATALOG.find((permission) => permission.slug === slug)?.conditions;
      const conditioned = ROLE_PERMISSION_CATALOG[roleName].filter(
        (slug) => Object.keys(conditionsOf(slug) ?? {}).length > 0,
      );

      expect(conditioned).toEqual(expected);
    });

    it('condition staff restore on the tombstone, so it can never edit a live household (#175)', () => {
      // The one static condition a staff role holds. Unconditioned, this
      // would be an `update` on every household: `updateHousehold` scopes its
      // write by the actor's `update` rules, so Admin could rename any live
      // household or change who may see it, which #244's floor left out on
      // purpose. With it, the rule and every write path's live filter can
      // never both match.
      const conditionsOf = (slug: string) => PERMISSION_CATALOG.find((entry) => entry.slug === slug)?.conditions;

      expect(conditionsOf('update:household:restore:administer')).toStrictEqual({ deletedAt: { not: null } });
      expect(conditionsOf('update:household:restore')).toStrictEqual({ deletedAt: { not: null } });
    });

    it('assign the per-household restore slug to no role: the delete grants it, one household at a time', () => {
      // Held by a role, it would reach every deleted household that role's
      // pass renders, with no window. It is issued as a `UserPermission`
      // pinned to one household id, with an expiry, by `deleteHousehold`.
      const holders = Object.entries(ROLE_PERMISSION_CATALOG)
        .filter(([, slugs]) => slugs.includes('update:household:restore'))
        .map(([role]) => role);

      expect(holders).toEqual([]);
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

    it('let User read its own games, a friend’s that reach friends, everyone’s Public ones and the ones shared with it, and nothing else', () => {
      const conditionsOf = (slug: string) => PERMISSION_CATALOG.find((entry) => entry.slug === slug)?.conditions;

      // `User` is held by every signed-in actor, so an unconditioned read here
      // is every private game handed to everyone (#472). Pinned exactly rather
      // than by shape, so a clause that goes missing fails here instead of
      // widening the read unnoticed.
      expect(conditionsOf('read:game')).toStrictEqual({ deletedAt: null, createdById: '{{ user.id }}' });
      expect(conditionsOf('read:game:friends')).toStrictEqual({
        deletedAt: null,
        reach: { in: ['Friends', 'FriendsOfFriends', 'Public'] },
        createdBy: { is: ACCEPTED_FRIEND_OF_ACTING_USER },
      });
      expect(conditionsOf('read:game:public')).toStrictEqual({ deletedAt: null, reach: 'Public' });
      // A share counts once it is in effect, and a user share only while no
      // block stands between its owner and the recipient (#810). A lost
      // `approvedAt` test would open a waiting share before anyone approved it.
      expect(conditionsOf('read:game:shared')).toStrictEqual({
        deletedAt: null,
        OR: [
          {
            shares: { some: { userId: '{{ user.id }}', approvedAt: { not: null } } },
            createdBy: { is: { NOT: BLOCK_WITH_ACTING_USER } },
          },
          {
            shares: {
              some: {
                approvedAt: { not: null },
                household: { is: { deletedAt: null, members: { some: { userId: '{{ user.id }}' } } } },
              },
            },
          },
        ],
      });
      expect(ROLE_PERMISSION_CATALOG[SystemRole.User]).toEqual(
        expect.arrayContaining(['read:game', 'read:game:friends', 'read:game:public', 'read:game:shared']),
      );
    });

    // Every signed-in user shares the games they created (#810). Pinned
    // exactly, as the game reads are: a lost `createdById` would let anyone
    // share anyone's game, and a lost `householdId: null` would let a user
    // share into any household past its member share policy.
    it('let User share only its own live games with users, list their shares and remove the shares it made', () => {
      const conditionsOf = (slug: string) => PERMISSION_CATALOG.find((entry) => entry.slug === slug)?.conditions;

      expect(conditionsOf('create:game_share')).toStrictEqual({
        householdId: null,
        game: { is: { deletedAt: null, createdById: '{{ user.id }}' } },
      });
      expect(conditionsOf('read:game_share:own')).toStrictEqual({ game: { is: { createdById: '{{ user.id }}' } } });
      expect(conditionsOf('delete:game_share')).toStrictEqual({ sharedById: '{{ user.id }}' });
      expect(ROLE_PERMISSION_CATALOG[SystemRole.User]).toEqual(
        expect.arrayContaining(['create:game_share', 'read:game_share:own', 'delete:game_share']),
      );
    });

    it('let User read import jobs, and no other job type (#479)', () => {
      const conditionsOf = (slug: string) => PERMISSION_CATALOG.find((entry) => entry.slug === slug)?.conditions;

      // An import job describes public content, so every user reads every
      // import. Pinned exactly: a lost `type` clause would hand every user every
      // job of every type, whatever its payload holds.
      expect(conditionsOf('read:job')).toStrictEqual({ type: 'GameImport' });
      expect(ROLE_PERMISSION_CATALOG[SystemRole.User]).toContain('read:job');
    });

    // The server's own plugin reads gate on `installedAt`, a column this grant
    // leaves out, because a type check would pass on it whatever its
    // conditions. So the field list is what keeps every user out of them.
    // Pinned exactly: a server-only column joining it opens those reads, and
    // `installedAt` joining it opens them outright.
    it('let User read installed plugins by their identity columns alone', () => {
      const entry = PERMISSION_CATALOG.find(({ slug }) => slug === 'read:plugin:installed');

      expect(entry?.conditions).toStrictEqual({ uninstalledAt: null });
      expect(entry?.fields).toStrictEqual(['id', 'slug', 'category', 'scope', 'enabled']);
      expect(ROLE_PERMISSION_CATALOG[SystemRole.User]).toContain('read:plugin:installed');
    });

    // Every signed-in user holds it, so a column joining the list is served to
    // every user by the first route that checks `read User` and serves it.
    it('let User read searchable users by the columns search serves, and let no guest read them', () => {
      const entry = PERMISSION_CATALOG.find(({ slug }) => slug === 'read:user:searchable');

      expect(entry?.conditions).toStrictEqual({ banned: false, profile: { is: { isSearchable: true } } });
      expect(entry?.fields).toStrictEqual(['id', 'username', 'firstName', 'lastName']);
      expect(ROLE_PERMISSION_CATALOG[SystemRole.User]).toContain('read:user:searchable');
      expect(ROLE_PERMISSION_CATALOG[SystemRole.AnonymousUser]).not.toContain('read:user:searchable');
    });

    // A profile has a reach, and user search composes this read, so a profile
    // that is not `Public` is its owner's alone, in search too (#495). A banned
    // user's profile is their own and staff's alone, as user search already
    // hides them (#840). Pinned exactly, as the game reads are: a lost clause
    // hands every profile to every user.
    it('let User read its own profile, an unbanned friend’s that reaches friends and every unbanned user’s Public one, and let no anonymous user read them', () => {
      const conditionsOf = (slug: string) => PERMISSION_CATALOG.find((entry) => entry.slug === slug)?.conditions;

      // A banned user keeps their own profile, so this rule carries no ban
      // clause (#840).
      expect(conditionsOf('read:user:profile:own')).toStrictEqual({ userId: '{{ user.id }}' });
      expect(conditionsOf('read:user:profile:friends')).toStrictEqual({
        reach: { in: ['Friends', 'FriendsOfFriends', 'Public'] },
        user: { is: { AND: [{ banned: false }, ACCEPTED_FRIEND_OF_ACTING_USER] } },
      });
      expect(conditionsOf('read:user:profile:public')).toStrictEqual({
        reach: 'Public',
        user: { is: { banned: false } },
      });
      expect(ROLE_PERMISSION_CATALOG[SystemRole.User]).toEqual(
        expect.arrayContaining(['read:user:profile:own', 'read:user:profile:friends', 'read:user:profile:public']),
      );
      expect(ROLE_PERMISSION_CATALOG[SystemRole.AnonymousUser]).not.toContain('read:user:profile:public');
      expect(ROLE_PERMISSION_CATALOG[SystemRole.AnonymousUser]).not.toContain('read:user:profile:friends');
    });

    // The ladder reads upwards: a reach wider than `Friends` still admits a
    // friend. Each of these but the collection rule once tested `Friends`
    // alone, so widening a household or an event to `Public` hid it from the
    // friends who could read it before (#495). The friends rules admit direct
    // friends at every rung from `Friends` up, and friends of friends read
    // through their own rules (#496).
    const rungsAdmittingFriends = ['Friends', 'FriendsOfFriends', 'Public'];

    it.each([
      ['read:event:friends', (reach: unknown) => ({ reach })],
      ['read:households:friends', (reach: unknown) => ({ reach })],
      ['read:event_occurrence:friends', (reach: unknown) => ({ event: { is: { reach } } })],
      ['read:event_policy:friends', (reach: unknown) => ({ event: { is: { reach } } })],
      ['read:household_member:friends', (reach: unknown) => ({ household: { is: { reach } } })],
      ['read:game_collection:friends', (reach: unknown) => ({ reach })],
      ['read:user:profile:friends', (reach: unknown) => ({ reach })],
      ['read:game:friends', (reach: unknown) => ({ reach })],
    ])('let a friend read through %s at every rung from Friends up', (slug, at) => {
      const entry = PERMISSION_CATALOG.find((candidate) => candidate.slug === slug);

      expect(entry?.conditions).toMatchObject(at({ in: rungsAdmittingFriends }));
      expect(ROLE_PERMISSION_CATALOG[SystemRole.User]).toContain(slug);
    });

    // A `Public` event is every signed-in user's to read, with its dates and
    // its policy. An anonymous user is left out: anyone can open an anonymous
    // session (#489), so a grant there would be signed-out access, which is a
    // server setting of its own (#813).
    it.each([
      ['read:event:public', { reach: 'Public' }],
      ['read:event_occurrence:public', { event: { is: { reach: 'Public' } } }],
      ['read:event_policy:public', { event: { is: { reach: 'Public' } } }],
    ])('let every signed-in user, and no anonymous user, read through %s', (slug, conditions) => {
      const entry = PERMISSION_CATALOG.find((candidate) => candidate.slug === slug);

      expect(entry?.conditions).toStrictEqual(conditions);
      expect(entry?.riskLevel).toBe(RiskLevel.Medium);
      expect(ROLE_PERMISSION_CATALOG[SystemRole.User]).toContain(slug);
      expect(ROLE_PERMISSION_CATALOG[SystemRole.AnonymousUser]).not.toContain(slug);
    });

    // The ladder's order is written in the rules, not in the enum, which
    // Prisma declares alphabetically. So a rung added to `Reach` fails here
    // until someone decides whether it admits a friend.
    it('leave only Private off the rungs that admit a friend', () => {
      expect(Object.values(Reach).filter((rung) => !rungsAdmittingFriends.includes(rung))).toEqual([Reach.Private]);
    });

    // Each sits beside its friends rule and adds to it: a direct friend keeps
    // reading through that one. Pinned exactly, because a lost block clause
    // would let someone the owner blocked step around it through a friend they
    // share (#496). The collection rule keeps the owner's
    // `showCollectionToFriends`, so a wider circle never sees what the narrower
    // one can't.
    //
    // Each admits `FriendsOfFriends` alone, and tests it ahead of the relation
    // in an `AND`, which Prisma emits in that order. The second friendship step
    // runs once per row it reaches, so a reach test after it, or one that also
    // passed `Public` rows, made a list several times slower (#496).
    it.each([
      [
        'read:event:friends-of-friends',
        { AND: [{ reach: 'FriendsOfFriends' }, { createdBy: { is: FRIEND_OF_FRIEND_OF_ACTING_USER } }] },
        RiskLevel.Medium,
      ],
      [
        'read:event_occurrence:friends-of-friends',
        {
          event: {
            is: { AND: [{ reach: 'FriendsOfFriends' }, { createdBy: { is: FRIEND_OF_FRIEND_OF_ACTING_USER } }] },
          },
        },
        RiskLevel.Medium,
      ],
      [
        'read:event_policy:friends-of-friends',
        {
          event: {
            is: { AND: [{ reach: 'FriendsOfFriends' }, { createdBy: { is: FRIEND_OF_FRIEND_OF_ACTING_USER } }] },
          },
        },
        RiskLevel.Medium,
      ],
      [
        'read:user:profile:friends-of-friends',
        {
          AND: [
            { reach: 'FriendsOfFriends' },
            { user: { is: { AND: [{ banned: false }, FRIEND_OF_FRIEND_OF_ACTING_USER] } } },
          ],
        },
        RiskLevel.Medium,
      ],
      [
        'read:game:friends-of-friends',
        {
          deletedAt: null,
          AND: [{ reach: 'FriendsOfFriends' }, { createdBy: { is: FRIEND_OF_FRIEND_OF_ACTING_USER } }],
        },
        RiskLevel.Low,
      ],
      [
        'read:game_collection:friends-of-friends',
        {
          deletedAt: null,
          AND: [
            { reach: 'FriendsOfFriends' },
            {
              user: {
                is: {
                  AND: [
                    { OR: [{ preferences: null }, { preferences: { is: { showCollectionToFriends: true } } }] },
                    FRIEND_OF_FRIEND_OF_ACTING_USER,
                  ],
                },
              },
            },
          ],
        },
        RiskLevel.Medium,
      ],
    ])('let a friend of a friend read through %s, with no block between them (#496)', (slug, conditions, risk) => {
      const entry = PERMISSION_CATALOG.find((candidate) => candidate.slug === slug);

      expect(entry?.conditions).toStrictEqual(conditions);
      // Rated as its friends rule is.
      expect(entry?.riskLevel).toBe(risk);
      expect(ROLE_PERMISSION_CATALOG[SystemRole.User]).toContain(slug);
      expect(ROLE_PERMISSION_CATALOG[SystemRole.AnonymousUser]).not.toContain(slug);
    });

    // The friends-of-friends rules leave `Public` to these, so the ladder reads
    // upwards across the two: a friend of a friend reads a `Public` item through
    // its public rule, whoever owns it (#496). A model given a friends-of-friends
    // rule without a public rule here would hide its `Public` items from friends
    // of friends.
    it.each([
      ['read:event:friends-of-friends', 'read:event:public', { reach: 'Public' }],
      [
        'read:event_occurrence:friends-of-friends',
        'read:event_occurrence:public',
        { event: { is: { reach: 'Public' } } },
      ],
      ['read:event_policy:friends-of-friends', 'read:event_policy:public', { event: { is: { reach: 'Public' } } }],
      [
        'read:user:profile:friends-of-friends',
        'read:user:profile:public',
        { reach: 'Public', user: { is: { banned: false } } },
      ],
      ['read:game:friends-of-friends', 'read:game:public', { deletedAt: null, reach: 'Public' }],
      ['read:game_collection:friends-of-friends', 'read:game_collection:public', { deletedAt: null, reach: 'Public' }],
    ])('let every reader of %s read Public items through %s', (friendsOfFriendsSlug, publicSlug, conditions) => {
      const holders = (slug: string) =>
        Object.entries(ROLE_PERMISSION_CATALOG)
          .filter(([, slugs]) => slugs.some((held) => held === slug))
          .map(([role]) => role);

      expect(PERMISSION_CATALOG.find(({ slug }) => slug === publicSlug)?.conditions).toStrictEqual(conditions);
      expect(holders(publicSlug)).toEqual(expect.arrayContaining(holders(friendsOfFriendsSlug)));
    });

    // A roster shown beyond its members is #231's question, and so is whose
    // block vetoes in a household of many members (#496).
    it('gives households and their rosters no friends-of-friends rule until #231 decides what they open', () => {
      const slugs = PERMISSION_CATALOG.map(({ slug }) => slug);

      expect(slugs).not.toContain('read:households:friends-of-friends');
      expect(slugs).not.toContain('read:household_member:friends-of-friends');
    });

    // A household sees a member's collection through the member's
    // `showAllGames` and its excluded games, whatever the entry's reach: the
    // reach says who beyond the owner's households sees it (#495).
    it('let a household read a member’s collection whatever its reach', () => {
      const entry = PERMISSION_CATALOG.find(({ slug }) => slug === 'read:game_collection:household');

      expect(entry?.conditions).toBeDefined();
      expect(entry?.conditions).not.toHaveProperty('reach');
      expect(entry?.conditions).toMatchObject({ deletedAt: null, excludedFromHouseholds: expect.anything() });
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

    it('derive HouseholdAdmin from HouseholdOwner minus the owner-only slugs, plus variants that stop at the Member role (#168)', () => {
      const owner = ROLE_PERMISSION_CATALOG[SystemRole.HouseholdOwner];
      const admin = ROLE_PERMISSION_CATALOG[SystemRole.HouseholdAdmin];

      expect(owner.filter((slug) => !admin.includes(slug)).sort()).toEqual([
        'create:household_invite',
        'delete:household',
        'manage:household_member',
        'update:household_invite:revoke',
        'update:household_role:transfer-ownership',
      ]);
      expect(admin.filter((slug) => !owner.includes(slug)).sort()).toEqual([
        'create:household_invite:as-admin',
        'manage:household_member:as-admin',
        'update:household_invite:revoke:as-admin',
      ]);
    });

    it('derive EventCoHost from EventHost minus event deletion only', () => {
      const host = ROLE_PERMISSION_CATALOG[SystemRole.EventHost];
      const coHost = ROLE_PERMISSION_CATALOG[SystemRole.EventCoHost];

      expect(host.filter((slug) => !coHost.includes(slug))).toEqual(['delete:event']);
    });

    it.each([SystemRole.HouseholdOwner, SystemRole.HouseholdAdmin])(
      "give %s no delete on an event or its dates: it edits and cancels the household's events, and deletes only what it hosts (#168, #567)",
      (roleName) => {
        const held = ROLE_PERMISSION_CATALOG[roleName];
        const eventDeletes = PERMISSION_CATALOG.filter(
          ({ slug, action, subject }) =>
            held.includes(slug) &&
            action === Action.delete &&
            (subject === ResourceType.Event || subject === ResourceType.EventOccurrence),
        ).map(({ slug }) => slug);

        expect(eventDeletes).toEqual([]);
        expect(held).toContain('update:event:household');
        expect(held).toContain('update:event_occurrence:cancel:household');
      },
    );

    it('grant create on household roles to nobody: adding a member writes its role row itself (#168)', () => {
      const creates = PERMISSION_CATALOG.filter(
        ({ action, subject }) => subject === ResourceType.HouseholdRole && action === Action.create,
      ).map(({ slug }) => slug);

      expect(creates).toEqual([]);
    });
  });
});
