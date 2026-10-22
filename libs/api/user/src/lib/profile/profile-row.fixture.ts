import { Reach } from '@bge/database';
import type { ProfileRow } from './profile-view';

/** A profile row as `PROFILE_SELECT` reads it, every field set, so a test can tell a served field from a left-out one. */
export function makeProfileRow(overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    userId: 'u-ada',
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
    user: { username: 'ada' },
    ...overrides,
  };
}
