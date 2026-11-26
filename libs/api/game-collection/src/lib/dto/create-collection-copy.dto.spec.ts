import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCollectionCopyDto } from './create-collection-copy.dto';

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function validated(payload: Record<string, unknown>) {
  const dto = plainToInstance(CreateCollectionCopyDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return { dto, properties: errors.map((error) => error.property) };
}

// The copy route's add takes the key that makes a retry safe, under the rule
// every keyed create shares (ADR 0002, #1231).
describe('CreateCollectionCopyDto (#1231)', () => {
  it('takes a clientRequestId, trimmed', async () => {
    const { dto, properties } = await validated({ clientRequestId: '  key-1 ', note: 'Deluxe' });

    expect(properties).toEqual([]);
    expect(dto.clientRequestId).toBe('key-1');
  });

  it.each([
    ['blank', '   '],
    ['not a string', 5],
  ])('refuses a clientRequestId that is %s', async (_, clientRequestId) => {
    await expect(validated({ clientRequestId })).resolves.toMatchObject({ properties: ['clientRequestId'] });
  });
});
