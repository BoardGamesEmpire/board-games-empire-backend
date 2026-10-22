import { Reach } from '@bge/database';
import { makeProfileRow } from './profile-row.fixture';
import { OWNER_ONLY_PROFILE_FIELDS, toProfileView } from './profile-view';

describe('toProfileView', () => {
  it("serves the profile's owner every field, the username flattened", () => {
    expect(toProfileView(makeProfileRow(), true)).toStrictEqual({
      userId: 'u-ada',
      username: 'ada',
      displayName: 'Ada Lovelace',
      avatarUrl: 'https://cdn.example/ada.png',
      bio: '**Engines** and games',
      pronouns: 'she/her',
      location: 'London',
      preferredPlayerCount: 4,
      willingToTeach: true,
      openToNewPlayers: true,
      houseRulesPreference: 'Flexible',
      hostingCapability: false,
      dietaryRestrictions: 'No nuts',
      accessibilityNeeds: 'Step-free access',
      reach: Reach.Friends,
      isSearchable: true,
    });
  });

  // Health details are the profile's owner's to share (#819, #830). Left out rather than
  // nulled, so a client can tell "not yours to see" from "left blank".
  it('leaves the health details, reach and searchable out for anyone else', () => {
    const view = toProfileView(makeProfileRow(), false);

    expect(Object.keys(view).sort()).toEqual([
      'avatarUrl',
      'bio',
      'displayName',
      'hostingCapability',
      'houseRulesPreference',
      'location',
      'openToNewPlayers',
      'preferredPlayerCount',
      'pronouns',
      'userId',
      'username',
      'willingToTeach',
    ]);
    expect(OWNER_ONLY_PROFILE_FIELDS).toEqual(['dietaryRestrictions', 'accessibilityNeeds', 'reach', 'isSearchable']);
  });

  it('leaves the row it was given as it was', () => {
    const row = makeProfileRow();

    toProfileView(row, false);

    expect(row).toStrictEqual(makeProfileRow());
  });
});
