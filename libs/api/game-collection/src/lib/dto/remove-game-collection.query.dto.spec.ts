import { GameRemovalReason } from '@bge/database';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RemoveGameCollectionQueryDto } from './remove-game-collection.query.dto';

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function propertiesWithErrors(query: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(
    plainToInstance(RemoveGameCollectionQueryDto, query, { enableImplicitConversion: true }),
    {
      whitelist: true,
      forbidNonWhitelisted: true,
    },
  );

  return errors.map((error) => error.property);
}

// A removal is dated as exactly as the user knows it, or today when they give
// no date. Whether the date has come yet is the service's to judge (#1231).
describe('RemoveGameCollectionQueryDto (#1231)', () => {
  it.each(['2019', '2019-03', '2019-03-02'])('accepts the removal date %s', async (removedOn) => {
    await expect(propertiesWithErrors({ removedOn, reason: GameRemovalReason.Sold })).resolves.toEqual([]);
  });

  it('accepts no date and no reason', async () => {
    await expect(propertiesWithErrors({})).resolves.toEqual([]);
  });

  it.each(['2019-13', '03/02/2019', '2019-03-02T10:00:00Z'])('refuses the removal date %s', async (removedOn) => {
    await expect(propertiesWithErrors({ removedOn })).resolves.toEqual(['removedOn']);
  });
});
