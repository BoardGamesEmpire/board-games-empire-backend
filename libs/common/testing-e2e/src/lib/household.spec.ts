import { SystemRole } from '@bge/database';
import { planRoster } from './household.js';

describe('planRoster', () => {
  it('folds the owner in as a HouseholdOwner entry', () => {
    const plan = planRoster('usr_owner');

    expect(plan.ownerEntry).toEqual({ userId: 'usr_owner', role: SystemRole.HouseholdOwner });
    expect(plan.memberEntries).toEqual([]);
  });

  it('preserves member order', () => {
    const plan = planRoster('usr_owner', [
      { userId: 'usr_a', role: SystemRole.HouseholdAdmin },
      { userId: 'usr_b', role: SystemRole.HouseholdMember },
      { userId: 'usr_c', role: SystemRole.HouseholdGuest },
    ]);

    expect(plan.memberEntries.map((entry) => entry.userId)).toEqual(['usr_a', 'usr_b', 'usr_c']);
  });

  it('rejects a roster that repeats a user, naming the constraint it would have tripped', () => {
    expect(() =>
      planRoster('usr_owner', [
        { userId: 'usr_a', role: SystemRole.HouseholdMember },
        { userId: 'usr_a', role: SystemRole.HouseholdAdmin },
      ]),
    ).toThrow(/\[householdId, userId\]/);
  });

  it('rejects the owner reappearing in the member roster', () => {
    expect(() => planRoster('usr_owner', [{ userId: 'usr_owner', role: SystemRole.HouseholdMember }])).toThrow(
      /usr_owner/,
    );
  });
});
