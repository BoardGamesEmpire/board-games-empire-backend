import { GameRemovalReason } from '@bge/database';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateCollectionCopyDto } from './update-collection-copy.dto';

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function propertiesWithErrors(payload: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(plainToInstance(UpdateCollectionCopyDto, payload, { enableImplicitConversion: true }), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  return errors.map((error) => error.property);
}

// A correction of a copy: null clears a field back to unknown, but a removal
// always has a date, so its date can be changed and never cleared (#1231).
describe('UpdateCollectionCopyDto (#1231)', () => {
  it('refuses removedOn: null', async () => {
    await expect(propertiesWithErrors({ removedOn: null })).resolves.toEqual(['removedOn']);
  });

  it.each(['2019', '2019-03', '2019-03-02'])('accepts the removal date %s', async (removedOn) => {
    await expect(propertiesWithErrors({ removedOn })).resolves.toEqual([]);
  });

  it('refuses a malformed removal date', async () => {
    await expect(propertiesWithErrors({ removedOn: '2019-13' })).resolves.toEqual(['removedOn']);
  });

  it.each([
    ['pricePaid', null],
    ['currentValue', null],
    ['removeReason', null],
    ['acquiredOn', null],
    ['releaseId', null],
    ['condition', null],
    ['note', null],
    ['acquiredFrom', null],
    ['removeReason', GameRemovalReason.Lost],
  ])('accepts %s: %s', async (property, value) => {
    await expect(propertiesWithErrors({ [property]: value })).resolves.toEqual([]);
  });

  it('checks a price it is given', async () => {
    await expect(propertiesWithErrors({ pricePaid: { amount: -1, currency: 'EUR' } })).resolves.toEqual(['pricePaid']);
  });

  it('refuses a field it does not know', async () => {
    await expect(propertiesWithErrors({ quantity: 2 })).resolves.toEqual(['quantity']);
  });
});
