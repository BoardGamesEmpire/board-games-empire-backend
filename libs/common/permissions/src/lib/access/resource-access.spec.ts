import { Action, ResourceType } from '@bge/database';
import type { ExtractSubjectType, SubjectRawRule } from '@casl/ability';
import { createPrismaAbility, type PrismaQuery } from '@casl/prisma';
import type { AppAbility, Subjects } from '../interfaces';
import { accessExtent, everyAbilityCan, resourceTypeAccess } from './resource-access';

describe('accessExtent', () => {
  const abilityOf = (rules: SubjectRawRule<Action, ExtractSubjectType<Subjects>, PrismaQuery>[]): AppAbility =>
    createPrismaAbility(rules) as AppAbility;

  it('answers none when there is no permission (#757)', () => {
    expect(accessExtent([abilityOf([])], Action.read, ResourceType.DataGateway)).toBe('none');
  });

  it('answers all for a wildcard read (#757)', () => {
    expect(
      accessExtent([abilityOf([{ action: Action.read, subject: 'all' }])], Action.read, ResourceType.DataGateway),
    ).toBe('all');
  });

  it('answers some for a grant with a condition (#757)', () => {
    const ability = abilityOf([{ action: Action.update, subject: ResourceType.Household, conditions: { id: 'h1' } }]);

    expect(accessExtent([ability], Action.update, ResourceType.Household)).toBe('some');
  });

  it('answers some when a denial with a condition follows a wildcard (#757)', () => {
    const ability = abilityOf([
      { action: Action.read, subject: 'all' },
      { action: Action.read, subject: ResourceType.DataGateway, conditions: { id: 'x' }, inverted: true },
    ]);

    expect(accessExtent([ability], Action.read, ResourceType.DataGateway)).toBe('some');
  });

  it('answers none when a direct denial covers the whole resource type (#757)', () => {
    // The shape applyUserPermissions emits for a direct denial with no condition and no fields (#757).
    const ability = abilityOf([
      { action: Action.read, subject: 'all' },
      { action: Action.read, subject: ResourceType.DataGateway, inverted: true },
    ]);

    expect(accessExtent([ability], Action.read, ResourceType.DataGateway)).toBe('none');
  });

  it('answers some for a field-limited grant (#757)', () => {
    const ability = abilityOf([{ action: Action.read, subject: ResourceType.Plugin, fields: ['id', 'slug'] }]);

    expect(accessExtent([ability], Action.read, ResourceType.Plugin)).toBe('some');
  });

  it('keeps a wildcard read at all beside a field-limited grant (#757)', () => {
    // Staff hold exactly this pair on Plugin: the wildcard read and the base role's installed-plugin read (#757).
    const ability = abilityOf([
      { action: Action.read, subject: 'all' },
      { action: Action.read, subject: ResourceType.Plugin, fields: ['id'], conditions: { userId: 'u1' } },
    ]);

    expect(accessExtent([ability], Action.read, ResourceType.Plugin)).toBe('all');
  });

  it('answers some when a denial is limited to a field (#757)', () => {
    const ability = abilityOf([
      { action: Action.update, subject: ResourceType.Event },
      { action: Action.update, subject: ResourceType.Event, fields: ['cancelledAt'], inverted: true },
    ]);

    expect(accessExtent([ability], Action.update, ResourceType.Event)).toBe('some');
  });

  it('answers all when a higher-priority grant of every field overrides a denial of one field (#757)', () => {
    // The grant comes later, so CASL ranks it higher, and a check on the
    // denied field passes: the denial no longer lowers the answer (#757).
    const ability = abilityOf([
      { action: Action.update, subject: ResourceType.Event, fields: ['cancelledAt'], inverted: true },
      { action: Action.update, subject: ResourceType.Event },
    ]);

    expect(ability.can(Action.update, ResourceType.Event, 'cancelledAt')).toBe(true);
    expect(accessExtent([ability], Action.update, ResourceType.Event)).toBe('all');
  });

  it('answers some when a denial of one field has a condition (#757)', () => {
    const ability = abilityOf([
      { action: Action.update, subject: ResourceType.Event },
      {
        action: Action.update,
        subject: ResourceType.Event,
        fields: ['cancelledAt'],
        conditions: { id: 'e1' },
        inverted: true,
      },
    ]);

    expect(accessExtent([ability], Action.update, ResourceType.Event)).toBe('some');
  });

  it('lets manage answer for each other action (#757)', () => {
    const ability = abilityOf([{ action: Action.manage, subject: ResourceType.HouseholdMember }]);

    for (const action of [Action.create, Action.read, Action.update, Action.delete]) {
      expect(accessExtent([ability], action, ResourceType.HouseholdMember)).toBe('all');
    }
  });

  it('never adds four actions up to manage (#757)', () => {
    const ability = abilityOf(
      [Action.create, Action.read, Action.update, Action.delete].map((action) => ({
        action,
        subject: ResourceType.Plugin,
      })),
    );

    expect(accessExtent([ability], Action.manage, ResourceType.Plugin)).toBe('none');
  });

  it('answers all for manage on everything (#757)', () => {
    expect(
      accessExtent([abilityOf([{ action: Action.manage, subject: 'all' }])], Action.manage, ResourceType.DataGateway),
    ).toBe('all');
  });

  it('answers a resource type with no model (#757)', () => {
    expect(
      accessExtent(
        [abilityOf([{ action: Action.read, subject: ResourceType.Campaign }])],
        Action.read,
        ResourceType.Campaign,
      ),
    ).toBe('all');
  });

  it('answers none when one ability holds no permission, as an API key with no key scopes does (#757)', () => {
    const keyOwner = abilityOf([{ action: Action.manage, subject: 'all' }]);

    expect(accessExtent([keyOwner, abilityOf([])], Action.read, ResourceType.DataGateway)).toBe('none');
  });

  it('answers some when one ability is pinned to a record (#757)', () => {
    const keyOwner = abilityOf([{ action: Action.manage, subject: 'all' }]);
    const key = abilityOf([{ action: Action.update, subject: ResourceType.DataGateway, conditions: { id: 'g1' } }]);

    expect(accessExtent([keyOwner, key], Action.update, ResourceType.DataGateway)).toBe('some');
  });

  it('answers all when every ability reaches every record (#757)', () => {
    const keyOwner = abilityOf([{ action: Action.manage, subject: 'all' }]);
    const key = abilityOf([{ action: Action.read, subject: ResourceType.DataGateway }]);

    expect(accessExtent([keyOwner, key], Action.read, ResourceType.DataGateway)).toBe('all');
  });

  it('answers none for an empty ability array (#757)', () => {
    expect(accessExtent([], Action.read, ResourceType.DataGateway)).toBe('none');
  });
});

describe('resourceTypeAccess', () => {
  const ignoreUnreadable = () => undefined;

  it('answers every action, in Action order (#757)', () => {
    const access = resourceTypeAccess(
      [createPrismaAbility([{ action: Action.read, subject: 'all' }]) as AppAbility],
      ResourceType.DataGateway,
      ignoreUnreadable,
    );

    expect(Object.keys(access)).toEqual(['create', 'read', 'update', 'delete', 'manage']);
    expect(access).toEqual({ create: 'none', read: 'all', update: 'none', delete: 'none', manage: 'none' });
  });

  it('answers none for an action the matcher cannot read, reports it, and keeps the other answers (#757)', () => {
    // An array where the matcher wants a scalar: CASL throws reading the
    // denial during the type check, as the guard's own check would (#757).
    const ability = createPrismaAbility([
      { action: Action.manage, subject: 'all' },
      { action: Action.delete, subject: ResourceType.Game, conditions: { tags: ['x'] }, inverted: true },
    ] as never) as AppAbility;
    const onUnreadable = jest.fn();

    const access = resourceTypeAccess([ability], ResourceType.Game, onUnreadable);

    expect(access).toEqual({ create: 'all', read: 'all', update: 'all', delete: 'none', manage: 'all' });
    expect(onUnreadable).toHaveBeenCalledTimes(1);
    expect(onUnreadable).toHaveBeenCalledWith(Action.delete, expect.any(Error));
  });
});

describe('everyAbilityCan', () => {
  const allowing = createPrismaAbility([{ action: Action.read, subject: ResourceType.GameSearch }]) as AppAbility;
  const refusing = createPrismaAbility([]) as AppAbility;

  it('allows when every ability allows the action on the type (#1076)', () => {
    expect(everyAbilityCan([allowing, allowing], Action.read, ResourceType.GameSearch)).toBe(true);
  });

  it('refuses when any ability refuses, as an API key and its owner are checked together (#1076)', () => {
    expect(everyAbilityCan([allowing, refusing], Action.read, ResourceType.GameSearch)).toBe(false);
  });

  it('refuses an empty ability array rather than answering the vacuous yes (#1076)', () => {
    expect(everyAbilityCan([], Action.read, ResourceType.GameSearch)).toBe(false);
  });

  it('counts a permission with a condition, as the type check does (#1076)', () => {
    const conditioned = createPrismaAbility([
      { action: Action.read, subject: ResourceType.Household, conditions: { id: 'h1' } },
    ]) as AppAbility;

    expect(everyAbilityCan([conditioned], Action.read, ResourceType.Household)).toBe(true);
  });
});
