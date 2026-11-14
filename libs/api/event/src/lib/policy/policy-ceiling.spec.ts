import { Action, PlatformType, ResourceType, type Prisma } from '@bge/database';
import type { AbilityService } from '@bge/permissions';
import {
  createMockAbilityService,
  createMockDatabaseService,
  makeEventPolicy,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import {
  canReadEventPolicy,
  eventPolicyReadArgs,
  readEventPolicyView,
  toEventPolicyViewOrNull,
} from './policy-ceiling';
import { POLICY_VIEW_INCLUDE } from './policy-view';

const asTx = (mock: MockDatabaseService): Prisma.TransactionClient => mock as unknown as Prisma.TransactionClient;

/** A ceiling of its own for each type and action, so a test can tell which one a query was given. */
const ceiling = (resourceType: string, action: string) => [{ ceiling: `${action}:${resourceType}` }];

const policy = makeEventPolicy('event-1', { id: 'policy-1' });

/** The policy as a read with the view's embed returns it. */
const row = {
  ...policy,
  allowedPlatformTypes: [{ platformType: PlatformType.Tabletop }],
  allowedPlatforms: [],
  allowedCategories: [{ categoryId: 'cat-1' }],
};

/** The same policy as it is served. */
const view = {
  ...policy,
  allowedPlatformTypes: [PlatformType.Tabletop],
  allowedPlatformIds: [],
  allowedCategoryIds: ['cat-1'],
};

describe('the event policy read ceiling', () => {
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;
  let ability: AbilityService;

  beforeEach(() => {
    db = createMockDatabaseService();
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockImplementation(ceiling);
    ability = abilityService as unknown as AbilityService;
  });

  // The ceiling goes in the top-level where, the one place a deny-all
  // ceiling is enforced (#559, #796).
  it("puts the read:event_policy ceiling in the read's top-level where, with the lists embedded (#796)", () => {
    expect(eventPolicyReadArgs(ability, 'event-1')).toEqual({
      where: { eventId: 'event-1', AND: ceiling(ResourceType.EventPolicy, Action.read) },
      include: POLICY_VIEW_INCLUDE,
    });
  });

  it('serves the policy the ceiling lets through, and null when it hides it (#796)', async () => {
    db.eventPolicy.findUnique.mockResolvedValueOnce(row as never);

    await expect(readEventPolicyView(asTx(db), ability, 'event-1')).resolves.toEqual(view);
    expect(db.eventPolicy.findUnique).toHaveBeenCalledWith(eventPolicyReadArgs(ability, 'event-1'));

    db.eventPolicy.findUnique.mockResolvedValueOnce(null as never);

    await expect(readEventPolicyView(asTx(db), ability, 'event-1')).resolves.toBeNull();
  });

  it('serves a row read under the ceiling as a view, and no row as null (#796)', () => {
    expect(toEventPolicyViewOrNull(row)).toEqual(view);
    expect(toEventPolicyViewOrNull(null)).toBeNull();
  });

  // A date's policy is the event's with overrides, so the event's read
  // ceiling is the date's too (#796, #1211).
  it("answers whether the caller may read the event's policy, under the same ceiling (#796)", async () => {
    db.eventPolicy.count.mockResolvedValueOnce(1 as never);

    await expect(canReadEventPolicy(asTx(db), ability, 'event-1')).resolves.toBe(true);
    expect(db.eventPolicy.count).toHaveBeenCalledWith({
      where: { eventId: 'event-1', AND: ceiling(ResourceType.EventPolicy, Action.read) },
    });

    db.eventPolicy.count.mockResolvedValueOnce(0 as never);

    await expect(canReadEventPolicy(asTx(db), ability, 'event-1')).resolves.toBe(false);
  });
});
