import { Action, PERMISSION_CATALOG, ResourceType } from '@bge/database';
import type { AppAbility } from '@bge/permissions';
import { createPrismaAbility } from '@casl/prisma';
import { canReadServerPlugins } from './read-server-plugins.policy';

const catalogRule = (slug: string) => {
  const entry = PERMISSION_CATALOG.find((candidate) => candidate.slug === slug);

  if (entry === undefined) {
    throw new Error(`no catalog entry '${slug}'`);
  }

  return { action: entry.action, subject: entry.subject, conditions: entry.conditions, fields: entry.fields };
};

const abilityOf = (...rules: object[]) => createPrismaAbility(rules as never) as AppAbility;

describe('canReadServerPlugins', () => {
  // The control: the grant every user holds passes the bare type check, which
  // is why the server reads cannot gate on it.
  it('refuses the identity-column grant every user holds, which a type check alone would pass', () => {
    const user = abilityOf(catalogRule('read:plugin:installed'));

    expect(user.can(Action.read, ResourceType.Plugin)).toBe(true);
    expect(canReadServerPlugins(user)).toBe(false);
  });

  it('passes read:plugin, which carries no field list', () => {
    expect(canReadServerPlugins(abilityOf(catalogRule('read:plugin')))).toBe(true);
  });

  it("passes staff's read wildcard, held beside the identity-column grant", () => {
    const staff = abilityOf(catalogRule('read:plugin:installed'), catalogRule('read:public_content'));

    expect(canReadServerPlugins(staff)).toBe(true);
  });

  // The shape an API key's scope row renders: the key narrows the list to the
  // plugin it names, and is not refused the route.
  it('passes a rule pinned to one plugin', () => {
    expect(
      canReadServerPlugins(abilityOf({ action: Action.read, subject: ResourceType.Plugin, conditions: { id: 'p-1' } })),
    ).toBe(true);
  });

  it('refuses an ability with no rule on Plugin', () => {
    expect(canReadServerPlugins(abilityOf())).toBe(false);
  });
});
