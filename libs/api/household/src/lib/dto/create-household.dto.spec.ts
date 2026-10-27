import { Reach } from '@bge/database';
import { MAX_CLIENT_REQUEST_ID_LENGTH } from '@bge/shared';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateHouseholdDto } from './create-household.dto';

type PlainPayload = Record<string, unknown>;

const VALID_PAYLOAD: PlainPayload = { name: 'Home' };

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
function instantiate(payload: PlainPayload): CreateHouseholdDto {
  return plainToInstance(CreateHouseholdDto, payload, { enableImplicitConversion: true });
}

async function propertiesWithErrors(payload: PlainPayload): Promise<string[]> {
  const errors = await validate(instantiate(payload), { whitelist: true, forbidNonWhitelisted: true });

  return errors.map((error) => error.property);
}

describe('CreateHouseholdDto', () => {
  it('accepts the minimal payload', async () => {
    await expect(propertiesWithErrors(VALID_PAYLOAD)).resolves.toEqual([]);
  });

  it('accepts a fully populated payload', async () => {
    const payload: PlainPayload = {
      ...VALID_PAYLOAD,
      reach: Reach.Friends,
      description: 'Board game night crew',
      image: 'https://example.test/avatar.png',
      language: 'pt-BR',
      clientRequestId: 'tz4a98xxat96iws9zmbrgj3a',
    };

    await expect(propertiesWithErrors(payload)).resolves.toEqual([]);
  });

  it.each([Reach.Private, Reach.Friends])('accepts reach %s', async (reach) => {
    await expect(propertiesWithErrors({ ...VALID_PAYLOAD, reach })).resolves.toEqual([]);
  });

  // The rungs a household read rule serves, and no others. `Public` waits on
  // #231 (#495), and so does `FriendsOfFriends` (#496). Null would reach a
  // non-nullable column as a 500.
  it.each([['Public'], ['FriendsOfFriends'], ['Household'], [null]])('rejects reach %p', async (reach) => {
    await expect(propertiesWithErrors({ ...VALID_PAYLOAD, reach })).resolves.toEqual(['reach']);
  });

  describe('clientRequestId (#210)', () => {
    it('is optional', async () => {
      const dto = instantiate(VALID_PAYLOAD);

      expect(dto.clientRequestId).toBeUndefined();
      await expect(propertiesWithErrors(VALID_PAYLOAD)).resolves.toEqual([]);
    });

    it('trims surrounding whitespace so padded retries resolve to one key', () => {
      const dto = instantiate({ ...VALID_PAYLOAD, clientRequestId: '  key-1  ' });

      expect(dto.clientRequestId).toBe('key-1');
    });

    it.each([
      ['an empty string', ''],
      ['whitespace only', '   '],
    ])('rejects %s rather than silently dropping the idempotency guarantee', async (_label, value) => {
      // A blank key must 400. Accepting it would leave the caller believing the
      // request was idempotent when the server had treated it as keyless.
      await expect(propertiesWithErrors({ ...VALID_PAYLOAD, clientRequestId: value })).resolves.toEqual([
        'clientRequestId',
      ]);
    });

    it('accepts a key at the length cap', async () => {
      const key = 'k'.repeat(MAX_CLIENT_REQUEST_ID_LENGTH);

      await expect(propertiesWithErrors({ ...VALID_PAYLOAD, clientRequestId: key })).resolves.toEqual([]);
    });

    it('rejects a key over the length cap', async () => {
      const key = 'k'.repeat(MAX_CLIENT_REQUEST_ID_LENGTH + 1);

      await expect(propertiesWithErrors({ ...VALID_PAYLOAD, clientRequestId: key })).resolves.toEqual([
        'clientRequestId',
      ]);
    });

    it('measures the cap after trimming', async () => {
      const key = ` ${'k'.repeat(MAX_CLIENT_REQUEST_ID_LENGTH)} `;

      await expect(propertiesWithErrors({ ...VALID_PAYLOAD, clientRequestId: key })).resolves.toEqual([]);
    });
  });
});
