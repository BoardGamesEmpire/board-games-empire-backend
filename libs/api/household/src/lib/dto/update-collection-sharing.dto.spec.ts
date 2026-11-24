import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateCollectionSharingDto } from './update-collection-sharing.dto';

type PlainPayload = Record<string, unknown>;

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function propertiesWithErrors(payload: PlainPayload): Promise<string[]> {
  const dto = plainToInstance(UpdateCollectionSharingDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return errors.map((error) => error.property);
}

describe('UpdateCollectionSharingDto takes collection sharing as a JSON boolean only (#170)', () => {
  it.each([
    ['true', { collectionSharing: true }],
    ['false', { collectionSharing: false }],
  ])('accepts %s', async (_label, payload) => {
    await expect(propertiesWithErrors(payload)).resolves.toEqual([]);
  });

  it('keeps false as false, so turning collection sharing off is never read as on (#170)', () => {
    const dto = plainToInstance(
      UpdateCollectionSharingDto,
      { collectionSharing: false },
      { enableImplicitConversion: true },
    );

    expect(dto.collectionSharing).toBe(false);
  });

  it.each([
    // Implicit conversion would make any non-empty string true, so the string
    // 'false' would turn collection sharing on.
    ["the string 'false'", { collectionSharing: 'false' }],
    ["the string 'true'", { collectionSharing: 'true' }],
    ['the number 1', { collectionSharing: 1 }],
    ['null', { collectionSharing: null }],
    // Required: a body that names no value changes nothing and is refused.
    ['a missing value', {}],
  ])('refuses %s (#170)', async (_label, payload) => {
    await expect(propertiesWithErrors(payload)).resolves.toEqual(['collectionSharing']);
  });
});
