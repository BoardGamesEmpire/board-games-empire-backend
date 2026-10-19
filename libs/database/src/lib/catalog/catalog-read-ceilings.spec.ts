import { Action, Prisma, ResourceType, RiskLevel, SystemRole } from '../client';
import { deriveReadCeilings, findReadsIgnoringReach, modelsWithField } from './catalog-read-ceilings';
import type { PermissionSeedDefinition } from './seed-definitions';

const definition = (overrides: Partial<PermissionSeedDefinition> & Pick<PermissionSeedDefinition, 'slug'>) =>
  ({
    action: Action.read,
    subject: ResourceType.Game,
    riskLevel: RiskLevel.Low,
    reason: 'fixture',
    ...overrides,
  }) satisfies PermissionSeedDefinition;

const SUBJECTS = ['all', ResourceType.Game, ResourceType.Household];

describe('deriveReadCeilings', () => {
  it('files each read grant under its subject and the role holding it', () => {
    const catalog = [
      definition({ slug: 'read:game', conditions: { createdById: '{{ user.id }}' } }),
      definition({ slug: 'read:households', subject: ResourceType.Household }),
    ];

    expect(deriveReadCeilings(catalog, { [SystemRole.User]: ['read:game', 'read:households'] }, SUBJECTS)).toEqual({
      all: {},
      Game: { User: { 'read:game': 'binds user.id' } },
      Household: { User: { 'read:households': 'every row' } },
    });
  });

  it('counts manage as a read, and nothing else', () => {
    const catalog = [
      definition({ slug: 'manage:game', action: Action.manage }),
      definition({ slug: 'create:game', action: Action.create }),
      definition({ slug: 'update:game', action: Action.update }),
      definition({ slug: 'delete:game', action: Action.delete }),
    ];

    expect(
      deriveReadCeilings(
        catalog,
        { [SystemRole.Admin]: ['manage:game', 'create:game', 'update:game', 'delete:game'] },
        SUBJECTS,
      ).Game,
    ).toEqual({ Admin: { 'manage:game': 'every row' } });
  });

  it('tells a static filter apart from a grant bound to the caller', () => {
    // The reason the reach has three values, not two. `{ deletedAt: null }` is
    // non-empty and still admits every live row, so an "empty or not" flag
    // could not see a grant lose its template and keep a static clause — the
    // change that makes a list install-wide for its holders.
    const catalog = [
      definition({ slug: 'read:game:public', conditions: { deletedAt: null, reach: 'Public' } }),
      definition({ slug: 'read:game', conditions: { deletedAt: null, createdById: '{{ user.id }}' } }),
    ];

    expect(
      deriveReadCeilings(catalog, { [SystemRole.User]: ['read:game:public', 'read:game'] }, SUBJECTS).Game,
    ).toEqual({
      User: { 'read:game:public': 'fixed filter', 'read:game': 'binds user.id' },
    });
  });

  it('names every variable a grant binds, once each and sorted', () => {
    const catalog = [
      definition({
        slug: 'read:household',
        subject: ResourceType.Household,
        conditions: { members: { some: { userId: '{{ user.id }}' } }, id: '{{ householdId }}', again: '{{ user.id }}' },
      }),
    ];

    expect(
      deriveReadCeilings(catalog, { [SystemRole.HouseholdMember]: ['read:household'] }, SUBJECTS).Household,
    ).toEqual({ HouseholdMember: { 'read:household': 'binds householdId, user.id' } });
  });

  it('does not count `role` as a binding, since it renders the same for every holder', () => {
    // The role pass renders `{{ role }}` as the holding role's own name, so a
    // clause on it gives every holder of that role the same rows.
    const catalog = [definition({ slug: 'read:game', conditions: { reach: '{{ role }}' } })];

    expect(deriveReadCeilings(catalog, { [SystemRole.User]: ['read:game'] }, SUBJECTS).Game).toEqual({
      User: { 'read:game': 'fixed filter' },
    });
  });

  it('names a section once, without the implicit iterator inside it', () => {
    const catalog = [definition({ slug: 'read:game', conditions: { createdById: '{{#user}}{{.}}{{/user}}' } })];

    expect(deriveReadCeilings(catalog, { [SystemRole.User]: ['read:game'] }, SUBJECTS).Game).toEqual({
      User: { 'read:game': 'binds user' },
    });
  });

  it('classifies conditions as the factory reads them, after JSON drops an undefined member', () => {
    // Stored as `{}`, so the grant is unconditioned at runtime whatever the
    // object in memory looks like.
    const catalog = [definition({ slug: 'read:game', conditions: { createdById: undefined } })];

    expect(deriveReadCeilings(catalog, { [SystemRole.User]: ['read:game'] }, SUBJECTS).Game).toEqual({
      User: { 'read:game': 'every row' },
    });
  });

  it('keeps a role or slug spelled like an Object.prototype member as data, at every level', () => {
    const catalog = [definition({ slug: '__proto__' }), definition({ slug: 'read:game' })];

    const game = deriveReadCeilings(
      catalog,
      { constructor: ['read:game'], [SystemRole.User]: ['__proto__'] },
      SUBJECTS,
    ).Game;

    expect(Object.getOwnPropertyDescriptor(game, 'constructor')?.value).toEqual({ 'read:game': 'every row' });
    expect(Object.getOwnPropertyDescriptor(game.User, '__proto__')?.value).toBe('every row');
    expect(Object.hasOwn(Object, 'read:game')).toBe(false);
  });

  it('keeps a wildcard under `all` rather than copying it onto every subject', () => {
    const catalog = [definition({ slug: 'read:public_content', subject: 'all' })];

    expect(deriveReadCeilings(catalog, { [SystemRole.Moderator]: ['read:public_content'] }, SUBJECTS)).toEqual({
      all: { Moderator: { 'read:public_content': 'every row' } },
      Game: {},
      Household: {},
    });
  });

  it('lists a subject no role reads as empty, so a type only the wildcards reach is visible', () => {
    expect(deriveReadCeilings([], {}, SUBJECTS)).toEqual({ all: {}, Game: {}, Household: {} });
  });

  it('refuses a grant on a subject the list does not name, rather than dropping it', () => {
    const catalog = [definition({ slug: 'read:platform', subject: ResourceType.Platform })];

    expect(() => deriveReadCeilings(catalog, { [SystemRole.User]: ['read:platform'] }, SUBJECTS)).toThrow(
      /read:platform.*Platform.*not in the subject list/,
    );
  });

  it('refuses a subject only an inherited property would answer to, rather than writing onto it', () => {
    const catalog = [definition({ slug: 'read:odd', subject: 'constructor' as ResourceType })];

    expect(() => deriveReadCeilings(catalog, { [SystemRole.User]: ['read:odd'] }, SUBJECTS)).toThrow(
      /read:odd.*constructor.*not in the subject list/,
    );
  });

  it('refuses a slug the catalog does not define', () => {
    expect(() => deriveReadCeilings([], { [SystemRole.User]: ['read:nothing'] }, SUBJECTS)).toThrow(
      /read:nothing.*does not define/,
    );
  });

  it('refuses a template it cannot parse, and says what is wrong with it', () => {
    const catalog = [definition({ slug: 'read:game', conditions: { createdById: '{{ user.id' } })];

    expect(() => deriveReadCeilings(catalog, { [SystemRole.User]: ['read:game'] }, SUBJECTS)).toThrow(
      /read:game.*cannot be rendered.*Unclosed tag/,
    );
  });

  it('names a token type the factory refuses, too', () => {
    const catalog = [definition({ slug: 'read:game', conditions: { createdById: '{{> shared }}' } })];

    expect(() => deriveReadCeilings(catalog, { [SystemRole.User]: ['read:game'] }, SUBJECTS)).toThrow(
      /read:game.*cannot be rendered.*unsupported token type '>'/,
    );
  });
});

describe('findReadsIgnoringReach', () => {
  const REACH_SUBJECTS = [ResourceType.Game];
  const EVERYONE = [SystemRole.User, SystemRole.AnonymousUser];

  const find = (catalog: PermissionSeedDefinition[], rolePermissions: Record<string, string[]>) =>
    findReadsIgnoringReach(catalog, rolePermissions, EVERYONE, REACH_SUBJECTS);

  it('finds an unconditioned read on a subject with a reach', () => {
    const catalog = [definition({ slug: 'read:game' })];

    expect(find(catalog, { [SystemRole.User]: ['read:game'] })).toEqual([
      { slug: 'read:game', role: SystemRole.User, subject: ResourceType.Game, reads: 'every row' },
    ]);
  });

  it('finds a static filter that does not test the reach', () => {
    // `{ deletedAt: null }` narrows the rows and still admits every live one,
    // whatever its owner chose.
    const catalog = [definition({ slug: 'read:game:live', conditions: { deletedAt: null } })];

    expect(find(catalog, { [SystemRole.User]: ['read:game:live'] })).toEqual([
      { slug: 'read:game:live', role: SystemRole.User, subject: ResourceType.Game, reads: 'fixed filter' },
    ]);
  });

  it('passes a static filter that tests the reach', () => {
    const catalog = [definition({ slug: 'read:game:public', conditions: { deletedAt: null, reach: 'Public' } })];

    expect(find(catalog, { [SystemRole.User]: ['read:game:public'] })).toEqual([]);
  });

  it('passes a grant bound to the caller, the shape of an own, membership or friends read', () => {
    const catalog = [definition({ slug: 'read:game', conditions: { createdById: '{{ user.id }}' } })];

    expect(find(catalog, { [SystemRole.User]: ['read:game'] })).toEqual([]);
  });

  it('does not count a reach test inside an OR, where the other branch admits rows past it', () => {
    const catalog = [
      definition({ slug: 'read:game:public', conditions: { OR: [{ reach: 'Public' }, { deletedAt: null }] } }),
    ];

    expect(find(catalog, { [SystemRole.User]: ['read:game:public'] })).toEqual([
      { slug: 'read:game:public', role: SystemRole.User, subject: ResourceType.Game, reads: 'fixed filter' },
    ]);
  });

  it('judges the guest role as it judges User', () => {
    const catalog = [definition({ slug: 'read:game' })];

    expect(find(catalog, { [SystemRole.AnonymousUser]: ['read:game'] })).toEqual([
      { slug: 'read:game', role: SystemRole.AnonymousUser, subject: ResourceType.Game, reads: 'every row' },
    ]);
  });

  it('leaves the roles it was not given alone', () => {
    // Staff read every row of every type through the wildcard, and their own
    // grants answer to the staff allowlist.
    const catalog = [definition({ slug: 'read:game' })];

    expect(find(catalog, { [SystemRole.Admin]: ['read:game'] })).toEqual([]);
  });

  it('counts manage as a read, and nothing else', () => {
    const catalog = [
      definition({ slug: 'manage:game', action: Action.manage }),
      definition({ slug: 'update:game', action: Action.update }),
    ];

    expect(find(catalog, { [SystemRole.User]: ['manage:game', 'update:game'] })).toEqual([
      { slug: 'manage:game', role: SystemRole.User, subject: ResourceType.Game, reads: 'every row' },
    ]);
  });

  it('leaves a subject with no reach alone', () => {
    const catalog = [definition({ slug: 'read:households', subject: ResourceType.Household })];

    expect(find(catalog, { [SystemRole.User]: ['read:households'] })).toEqual([]);
  });

  it('refuses a slug the catalog does not define', () => {
    expect(() => find([], { [SystemRole.User]: ['read:game'] })).toThrow(
      "Role 'User' holds 'read:game', which the permission catalog does not define",
    );
  });
});

describe('modelsWithField', () => {
  it('lists the models whose scalar fields include the field', () => {
    const namespace = {
      ModelName: { Game: 'Game', Platform: 'Platform' },
      GameScalarFieldEnum: { id: 'id', reach: 'reach' },
      PlatformScalarFieldEnum: { id: 'id' },
    };

    expect(modelsWithField(namespace, 'reach')).toEqual(['Game']);
  });

  it('refuses a model with no scalar field enum, rather than leaving it out', () => {
    const namespace = { ModelName: { Game: 'Game' } };

    expect(() => modelsWithField(namespace, 'reach')).toThrow("No 'GameScalarFieldEnum' for model 'Game'");
  });

  it('finds every model #495 gives a reach in the generated client', () => {
    expect(modelsWithField(Prisma, 'reach')).toEqual(
      expect.arrayContaining(['Event', 'Game', 'GameCollection', 'Household', 'MediaObject', 'UserProfile']),
    );
  });
});
