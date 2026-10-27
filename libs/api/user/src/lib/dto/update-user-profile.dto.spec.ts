import { Reach } from '@bge/database';
import { validationCatalogKeys } from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateUserProfileDto } from './update-user-profile.dto';

/** Bound as the global pipe binds a body: implicit conversion on. */
const bind = (plain: Record<string, unknown>) =>
  plainToInstance(UpdateUserProfileDto, plain, { enableImplicitConversion: true });

/** Validated as the global pipe validates it: an unknown key is refused, not dropped. */
const keysFor = async (plain: Record<string, unknown>) =>
  validationCatalogKeys(await validate(bind(plain), { whitelist: true, forbidNonWhitelisted: true }));

/** The fields the profile's columns keep a value for, so null can't be stored in them. */
const NON_NULLABLE = [
  'reach',
  'isSearchable',
  'willingToTeach',
  'openToNewPlayers',
  'hostingCapability',
  'displayName',
];

/** The optional text fields, which null or a blank string clears. */
const CLEARABLE_TEXT = [
  'bio',
  'pronouns',
  'location',
  'houseRulesPreference',
  'dietaryRestrictions',
  'accessibilityNeeds',
];

describe('UpdateUserProfileDto', () => {
  it('accepts every reach a profile read rule serves, and no other', async () => {
    for (const reach of [Reach.Public, Reach.FriendsOfFriends, Reach.Friends, Reach.Private]) {
      expect(await keysFor({ reach })).toEqual({});
    }

    // No longer a reach (#808).
    expect(await keysFor({ reach: 'Household' })).toEqual({ 'reach.isIn': 'validation.isIn' });
  });

  it.each(NON_NULLABLE)('refuses null for %s, whose column keeps a value', async (field) => {
    const keys = await keysFor({ [field]: null });

    expect(Object.keys(keys).some((key) => key.startsWith(`${field}.`))).toBe(true);
  });

  it('takes true and false for the switches', async () => {
    expect(
      await keysFor({ willingToTeach: false, openToNewPlayers: true, hostingCapability: true, isSearchable: false }),
    ).toEqual({});
  });

  // The global pipe converts implicitly, which turns any non-empty string into
  // true, so "false" would have switched a setting on (#819).
  it.each(['isSearchable', 'willingToTeach', 'openToNewPlayers', 'hostingCapability'])(
    'refuses %s sent as a string rather than reading "false" as true',
    async (field) => {
      expect(await keysFor({ [field]: 'false' })).toEqual({ [`${field}.isBoolean`]: 'validation.isBoolean' });
    },
  );

  it('trims the display name and refuses one that is only spaces (#818)', async () => {
    expect(bind({ displayName: '  Ada Lovelace ' }).displayName).toBe('Ada Lovelace');
    expect(await keysFor({ displayName: '  Ada Lovelace ' })).toEqual({});

    expect(await keysFor({ displayName: '   ' })).toEqual({ 'displayName.isNotEmpty': 'validation.isNotEmpty' });
  });

  it.each(CLEARABLE_TEXT)('stores a blank %s as null', async (field) => {
    expect(bind({ [field]: '   ' })[field as keyof UpdateUserProfileDto]).toBeNull();
    expect(await keysFor({ [field]: '   ' })).toEqual({});
  });

  it.each(CLEARABLE_TEXT)('clears %s with null', async (field) => {
    expect(bind({ [field]: null })[field as keyof UpdateUserProfileDto]).toBeNull();
    expect(await keysFor({ [field]: null })).toEqual({});
  });

  it('trims the text it keeps', () => {
    expect(bind({ pronouns: ' she/her ' }).pronouns).toBe('she/her');
  });

  // A bio is Markdown, where leading spaces can start a code block.
  it('keeps a bio as sent', () => {
    expect(bind({ bio: '    rolls 2d6' }).bio).toBe('    rolls 2d6');
  });

  it.each([
    ['bio', 2_000],
    ['displayName', 64],
    ['pronouns', 40],
    ['location', 100],
    ['houseRulesPreference', 200],
    ['dietaryRestrictions', 500],
    ['accessibilityNeeds', 500],
  ])('takes a %s of %i characters and refuses one longer', async (field, cap) => {
    expect(await keysFor({ [field]: 'a'.repeat(cap) })).toEqual({});
    expect(await keysFor({ [field]: 'a'.repeat(cap + 1) })).toEqual({
      [`${field}.maxLength`]: 'validation.maxLength',
    });
  });

  it('takes a player count from 1 to 100, or null to clear it', async () => {
    for (const preferredPlayerCount of [1, 100, null]) {
      expect(await keysFor({ preferredPlayerCount })).toEqual({});
    }

    expect(await keysFor({ preferredPlayerCount: 0 })).toEqual({ 'preferredPlayerCount.min': 'validation.min' });
    expect(await keysFor({ preferredPlayerCount: 101 })).toEqual({ 'preferredPlayerCount.max': 'validation.max' });
    expect(await keysFor({ preferredPlayerCount: 2.5 })).toEqual({ 'preferredPlayerCount.isInt': 'validation.isInt' });
  });

  // The avatar can't be changed here until #829, and the game length waits
  // on #831 with the other game tastes.
  it.each(['avatarUrl', 'preferredGameLengthId'])('refuses %s', async (field) => {
    expect(Object.keys(await keysFor({ [field]: 'anything' }))).toEqual([`${field}.whitelistValidation`]);
  });
});
