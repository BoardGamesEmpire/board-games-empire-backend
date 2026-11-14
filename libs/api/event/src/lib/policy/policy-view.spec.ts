import { OccurrenceOverrideScope, PlatformType } from '@bge/database';
import { makeEventOccurrencePolicy, makeEventPolicy } from '@bge/testing';
import { toEventPolicyView, toOccurrencePolicyView } from './policy-view';

/** The lists as a read with the view's embed returns them: join rows, in no particular order. */
const joinRows = {
  allowedPlatformTypes: [{ platformType: PlatformType.Tabletop }, { platformType: PlatformType.Console }],
  allowedPlatforms: [{ platformId: 'plat-2' }, { platformId: 'plat-1' }],
  allowedCategories: [{ categoryId: 'cat-3' }, { categoryId: 'cat-1' }],
};

/** The lists as they are served: plain and sorted, so the same stored set reads the same every time. */
const servedLists = {
  allowedPlatformTypes: [PlatformType.Console, PlatformType.Tabletop],
  allowedPlatformIds: ['plat-1', 'plat-2'],
  allowedCategoryIds: ['cat-1', 'cat-3'],
};

describe('toEventPolicyView', () => {
  it("serves the event's policy with its join rows as sorted lists, and its override scope (#1268, #796)", () => {
    const policy = makeEventPolicy('event-1', { occurrenceOverrideScope: OccurrenceOverrideScope.TightenOnly });

    expect(toEventPolicyView({ ...policy, ...joinRows })).toEqual({ ...policy, ...servedLists });
  });

  it('serves empty lists for a policy with no join rows (#1268)', () => {
    const policy = makeEventPolicy('event-1');

    expect(
      toEventPolicyView({ ...policy, allowedPlatformTypes: [], allowedPlatforms: [], allowedCategories: [] }),
    ).toEqual({ ...policy, allowedPlatformTypes: [], allowedPlatformIds: [], allowedCategoryIds: [] });
  });
});

describe('toOccurrencePolicyView', () => {
  // A client tells "the event's" (an empty list) from "no restriction" (a
  // flag), so both are served as stored (#796, #1211).
  it("serves a date's policy with its join rows as sorted lists, and its no-restriction flags (#796)", () => {
    const policy = makeEventOccurrencePolicy('occ-1', { platformsUnrestricted: true, capacityUnrestricted: true });

    expect(toOccurrencePolicyView({ ...policy, ...joinRows })).toEqual({ ...policy, ...servedLists });
  });

  it("serves empty lists for a date that keeps the event's (#796)", () => {
    const policy = makeEventOccurrencePolicy('occ-1');

    expect(
      toOccurrencePolicyView({ ...policy, allowedPlatformTypes: [], allowedPlatforms: [], allowedCategories: [] }),
    ).toEqual({ ...policy, allowedPlatformTypes: [], allowedPlatformIds: [], allowedCategoryIds: [] });
  });
});
