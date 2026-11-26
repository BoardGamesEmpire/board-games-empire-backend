import { GameMedium, Reach } from '@bge/database';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateGameCollectionDto } from './create-game-collection.dto';
import { UpdateGameCollectionDto } from './update-game-collection.dto';

type PlainPayload = Record<string, unknown>;

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function propertiesWithErrors(
  Dto: typeof CreateGameCollectionDto | typeof UpdateGameCollectionDto,
  payload: PlainPayload,
): Promise<string[]> {
  const errors = await validate(plainToInstance(Dto, payload, { enableImplicitConversion: true }), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  return errors.map((error) => error.property);
}

// A copy holds its own edition, and the entry's number of copies is counted
// from them, so neither is the entry's to write: the whitelist answers 400
// (#1231).
describe.each([
  ['POST', CreateGameCollectionDto, { platformGameId: 'pg-1', medium: GameMedium.Physical }],
  ['PATCH', UpdateGameCollectionDto, { favorite: true }],
])('%s refuses quantity and releaseId (#1231)', (_name, Dto, base: PlainPayload) => {
  it.each([
    ['quantity', 2],
    ['releaseId', 'release-1'],
  ])('refuses %s', async (property, value) => {
    await expect(propertiesWithErrors(Dto, { ...base, [property]: value })).resolves.toEqual([property]);
  });

  it('accepts the payload without them', async () => {
    await expect(propertiesWithErrors(Dto, base)).resolves.toEqual([]);
  });
});

describe.each([
  ['CreateGameCollectionDto', CreateGameCollectionDto, { platformGameId: 'pg-1', medium: GameMedium.Physical }],
  ['UpdateGameCollectionDto', UpdateGameCollectionDto, {}],
])('%s reach', (_name, Dto, base: PlainPayload) => {
  const reachErrors = (payload: PlainPayload) => propertiesWithErrors(Dto, { ...base, ...payload });

  it.each([Reach.Private, Reach.Friends, Reach.FriendsOfFriends, Reach.ExtendedNetwork, Reach.Public])(
    'accepts %s',
    async (reach) => {
      await expect(reachErrors({ reach })).resolves.toEqual([]);
    },
  );

  it('accepts the field left out', async () => {
    await expect(reachErrors({})).resolves.toEqual([]);
  });

  // `Household` is no longer a reach (#495), and null would reach a
  // non-nullable column as a 500.
  it.each([['Household'], [null]])('rejects %p', async (reach) => {
    await expect(reachErrors({ reach })).resolves.toEqual(['reach']);
  });
});

// The copy an add creates, when it creates one: every field optional, each
// one checked, and nothing the copy doesn't name. The money object is checked
// as its own DTO (#1231).
describe('CreateGameCollectionDto copy (#1231)', () => {
  const base = { platformGameId: 'pg-1', medium: GameMedium.Physical };
  const copyErrors = (copy: unknown) => propertiesWithErrors(CreateGameCollectionDto, { ...base, copy });

  it('accepts a copy with every field', async () => {
    await expect(
      copyErrors({
        releaseId: 'rel-1',
        condition: 'LikeNew',
        acquiredOn: '2019-03',
        acquiredFrom: 'x'.repeat(200),
        pricePaid: { amount: 2500, currency: 'EUR' },
        currentValue: { amount: 0, currency: 'JPY' },
        note: 'x'.repeat(10000),
      }),
    ).resolves.toEqual([]);
  });

  it('accepts an empty copy, and none at all', async () => {
    await expect(copyErrors({})).resolves.toEqual([]);
    await expect(propertiesWithErrors(CreateGameCollectionDto, base)).resolves.toEqual([]);
  });

  it.each([
    ['an acquisition date that is no date', { acquiredOn: '2019-13' }],
    ['a condition it does not know', { condition: 'Mint' }],
    ['where it came from, past 200 characters', { acquiredFrom: 'x'.repeat(201) }],
    ['a note past 10000 characters', { note: 'x'.repeat(10001) }],
    ['a price with no currency', { pricePaid: { amount: 100 } }],
    ['a value below zero', { currentValue: { amount: -1, currency: 'EUR' } }],
    ['a field a copy does not have', { quantity: 2 }],
  ])('refuses %s', async (_, copy) => {
    await expect(copyErrors(copy)).resolves.toEqual(['copy']);
  });

  it('refuses a copy that is not an object', async () => {
    await expect(copyErrors('a copy')).resolves.toEqual(['copy']);
  });
});
