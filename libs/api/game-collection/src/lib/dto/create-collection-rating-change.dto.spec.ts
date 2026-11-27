import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCollectionRatingChangeDto } from './create-collection-rating-change.dto';

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function propertiesWithErrors(payload: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(
    plainToInstance(CreateCollectionRatingChangeDto, payload, { enableImplicitConversion: true }),
    { whitelist: true, forbidNonWhitelisted: true },
  );

  return errors.map((error) => error.property);
}

// An earlier rating names both what the rating became and when: a clearing is
// `rating: null`, never a missing rating (#1231).
describe('CreateCollectionRatingChangeDto (#1231)', () => {
  it.each([1, 7, 10, null])('accepts the rating %s', async (rating) => {
    await expect(propertiesWithErrors({ occurredOn: '2019', rating })).resolves.toEqual([]);
  });

  it.each([0, 11, 7.5, -1])('refuses the rating %s', async (rating) => {
    await expect(propertiesWithErrors({ occurredOn: '2019', rating })).resolves.toEqual(['rating']);
  });

  it('refuses a body with no rating, which a clearing must send as null', async () => {
    await expect(propertiesWithErrors({ occurredOn: '2019' })).resolves.toEqual(['rating']);
  });

  it.each(['2019', '2019-03', '2019-03-02'])('accepts the date %s', async (occurredOn) => {
    await expect(propertiesWithErrors({ occurredOn, rating: 5 })).resolves.toEqual([]);
  });

  it('refuses a body with no date', async () => {
    await expect(propertiesWithErrors({ rating: 5 })).resolves.toEqual(['occurredOn']);
  });

  it.each([null, '2019-13', '19', 'yesterday'])('refuses the date %s', async (occurredOn) => {
    await expect(propertiesWithErrors({ occurredOn, rating: 5 })).resolves.toEqual(['occurredOn']);
  });

  it('accepts a clientRequestId, and refuses a blank one', async () => {
    await expect(propertiesWithErrors({ clientRequestId: 'key-1', occurredOn: '2019', rating: 5 })).resolves.toEqual(
      [],
    );
    await expect(propertiesWithErrors({ clientRequestId: '  ', occurredOn: '2019', rating: 5 })).resolves.toEqual([
      'clientRequestId',
    ]);
  });

  it('refuses a field it does not know', async () => {
    await expect(propertiesWithErrors({ occurredOn: '2019', rating: 5, retractedAt: null })).resolves.toEqual([
      'retractedAt',
    ]);
  });
});
