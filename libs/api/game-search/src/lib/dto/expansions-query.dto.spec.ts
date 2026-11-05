import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { EXPANSIONS_ID_MAX_LENGTH, EXPANSIONS_LOCALE_MAX_LENGTH, ExpansionsQueryDto } from './expansions-query.dto';

/**
 * #1067. Every field reaches the coordinator, and all but `gameId` key its
 * expansions cache, so each is bounded: an unbounded one would let each
 * request write a fresh cache entry of any size and ask the DataGateway again
 * on the server's credentials.
 */
describe('ExpansionsQueryDto', () => {
  const failingFields = async (plain: Record<string, unknown>): Promise<string[]> => {
    const errors = await validate(plainToInstance(ExpansionsQueryDto, plain));
    return errors.map((error) => error.property);
  };

  it('accepts each id at its limit, and a locale at its limit', async () => {
    const id = 'a'.repeat(EXPANSIONS_ID_MAX_LENGTH);

    expect(
      await failingFields({
        gatewayId: id,
        externalId: id,
        gameId: id,
        locale: 'a'.repeat(EXPANSIONS_LOCALE_MAX_LENGTH),
      }),
    ).toEqual([]);
  });

  it.each(['gatewayId', 'externalId', 'gameId'])('refuses a %s one character past the limit', async (field) => {
    expect(await failingFields({ [field]: 'a'.repeat(EXPANSIONS_ID_MAX_LENGTH + 1) })).toEqual([field]);
  });

  it('refuses a locale one character past the limit', async () => {
    expect(await failingFields({ locale: 'a'.repeat(EXPANSIONS_LOCALE_MAX_LENGTH + 1) })).toEqual(['locale']);
  });
});
