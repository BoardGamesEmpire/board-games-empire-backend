import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateCollectionRatingChangeDto } from './update-collection-rating-change.dto';

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function propertiesWithErrors(payload: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(
    plainToInstance(UpdateCollectionRatingChangeDto, payload, { enableImplicitConversion: true }),
    { whitelist: true, forbidNonWhitelisted: true },
  );

  return errors.map((error) => error.property);
}

// A correction of a rating change: a field left out keeps its value, and null
// is a value of its own: a clearing, or an unknown date (#1231).
describe('UpdateCollectionRatingChangeDto (#1231)', () => {
  it('accepts a body naming either field, or none', async () => {
    await expect(propertiesWithErrors({})).resolves.toEqual([]);
    await expect(propertiesWithErrors({ rating: 3 })).resolves.toEqual([]);
    await expect(propertiesWithErrors({ occurredOn: '2019-03' })).resolves.toEqual([]);
  });

  it.each([
    ['rating', null],
    ['occurredOn', null],
  ])('accepts %s: %s', async (property, value) => {
    await expect(propertiesWithErrors({ [property]: value })).resolves.toEqual([]);
  });

  it.each([0, 11, 2.5])('refuses the rating %s', async (rating) => {
    await expect(propertiesWithErrors({ rating })).resolves.toEqual(['rating']);
  });

  it.each(['2019-13', '19', 'yesterday'])('refuses the date %s', async (occurredOn) => {
    await expect(propertiesWithErrors({ occurredOn })).resolves.toEqual(['occurredOn']);
  });

  // A correction that rewrote the add's key would strand its retry into a
  // second change, so the key is the add's alone (ADR 0002, #1231).
  it('refuses a clientRequestId', async () => {
    await expect(propertiesWithErrors({ clientRequestId: 'key-1' })).resolves.toEqual(['clientRequestId']);
  });

  it('refuses a field it does not know', async () => {
    await expect(propertiesWithErrors({ retractedAt: null })).resolves.toEqual(['retractedAt']);
  });
});
