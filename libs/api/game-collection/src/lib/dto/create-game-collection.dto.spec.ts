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
