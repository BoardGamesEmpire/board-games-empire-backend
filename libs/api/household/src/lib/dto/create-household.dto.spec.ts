import { Visibility } from '@bge/database';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { HOUSEHOLD_MAX_CLIENT_REQUEST_ID_LENGTH } from '../constants/household.constants';
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
      visibility: Visibility.Friends,
      description: 'Board game night crew',
      image: 'https://example.test/avatar.png',
      language: 'pt-BR',
      clientRequestId: 'tz4a98xxat96iws9zmbrgj3a',
    };

    await expect(propertiesWithErrors(payload)).resolves.toEqual([]);
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
      const key = 'k'.repeat(HOUSEHOLD_MAX_CLIENT_REQUEST_ID_LENGTH);

      await expect(propertiesWithErrors({ ...VALID_PAYLOAD, clientRequestId: key })).resolves.toEqual([]);
    });

    it('rejects a key over the length cap', async () => {
      const key = 'k'.repeat(HOUSEHOLD_MAX_CLIENT_REQUEST_ID_LENGTH + 1);

      await expect(propertiesWithErrors({ ...VALID_PAYLOAD, clientRequestId: key })).resolves.toEqual([
        'clientRequestId',
      ]);
    });

    it('measures the cap after trimming', async () => {
      const key = ` ${'k'.repeat(HOUSEHOLD_MAX_CLIENT_REQUEST_ID_LENGTH)} `;

      await expect(propertiesWithErrors({ ...VALID_PAYLOAD, clientRequestId: key })).resolves.toEqual([]);
    });
  });
});
