import { GameMedium, Reach } from '@bge/database';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateGameCollectionDto } from './create-game-collection.dto';
import { UpdateGameCollectionDto } from './update-game-collection.dto';

type PlainPayload = Record<string, unknown>;

describe.each([
  ['CreateGameCollectionDto', CreateGameCollectionDto, { platformGameId: 'pg-1', medium: GameMedium.Physical }],
  ['UpdateGameCollectionDto', UpdateGameCollectionDto, {}],
])('%s reach', (_name, Dto, base: PlainPayload) => {
  /** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
  const propertiesWithErrors = async (payload: PlainPayload) => {
    const errors = await validate(plainToInstance(Dto, { ...base, ...payload }, { enableImplicitConversion: true }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    return errors.map((error) => error.property);
  };

  it.each([Reach.Private, Reach.Friends, Reach.Public])('accepts %s', async (reach) => {
    await expect(propertiesWithErrors({ reach })).resolves.toEqual([]);
  });

  it('accepts the field left out', async () => {
    await expect(propertiesWithErrors({})).resolves.toEqual([]);
  });

  // `FriendsOfFriends` waits on #496, which defines friends of friends,
  // `Household` is no longer a reach (#495), and null would reach a
  // non-nullable column as a 500.
  it.each([['FriendsOfFriends'], ['Household'], [null]])('rejects %p', async (reach) => {
    await expect(propertiesWithErrors({ reach })).resolves.toEqual(['reach']);
  });
});
