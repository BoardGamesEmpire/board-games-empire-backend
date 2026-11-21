import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AddOccurrenceDto } from './add-occurrence.dto';

type PlainPayload = Record<string, unknown>;

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function constraintsByProperty(payload: PlainPayload): Promise<Record<string, string[]>> {
  const dto = plainToInstance(AddOccurrenceDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return Object.fromEntries(errors.map((error) => [error.property, Object.keys(error.constraints ?? {})]));
}

describe('AddOccurrenceDto', () => {
  // The column is a 32-bit Int, so a larger number answers 400 naming the
  // field rather than failing the write as a 500 (#1444).
  it('refuses a sortOrder past the 32-bit column range (#1444)', async () => {
    await expect(constraintsByProperty({ sortOrder: 2 ** 31 })).resolves.toEqual({ sortOrder: ['max'] });
    await expect(constraintsByProperty({ sortOrder: 2 ** 31 - 1 })).resolves.toEqual({});
  });
});
