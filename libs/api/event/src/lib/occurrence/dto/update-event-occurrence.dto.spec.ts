import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateEventOccurrenceDto } from './update-event-occurrence.dto';

type PlainPayload = Record<string, unknown>;

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function propertiesWithErrors(payload: PlainPayload): Promise<string[]> {
  const dto = plainToInstance(UpdateEventOccurrenceDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return errors.map((error) => error.property);
}

describe('UpdateEventOccurrenceDto', () => {
  // PartialType's IsOptional skipped null as well as a missing key, so a null
  // reached the non-nullable column as a 500 (#1275).
  it('refuses null for sortOrder, which a date always has (#1275)', async () => {
    await expect(propertiesWithErrors({ sortOrder: null })).resolves.toEqual(['sortOrder']);
  });

  it('accepts a patch that leaves sortOrder out (#1275)', async () => {
    await expect(propertiesWithErrors({ label: 'Saturday' })).resolves.toEqual([]);
  });

  it('still refuses a negative sortOrder (#1275)', async () => {
    await expect(propertiesWithErrors({ sortOrder: -1 })).resolves.toEqual(['sortOrder']);
  });

  it.each(['label', 'startDate', 'endDate', 'location'])(
    'accepts null for %s, which clears it (#1275)',
    async (field) => {
      await expect(propertiesWithErrors({ [field]: null })).resolves.toEqual([]);
    },
  );
});
