import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateEventOccurrenceDto } from './create-event-occurrence.dto';
import { UpdateEventOccurrenceDto } from './update-event-occurrence.dto';

type PlainPayload = Record<string, unknown>;

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function constraintsByProperty(
  dtoClass: typeof CreateEventOccurrenceDto | typeof UpdateEventOccurrenceDto,
  payload: PlainPayload,
): Promise<Record<string, string[]>> {
  const dto = plainToInstance(dtoClass, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return Object.fromEntries(errors.map((error) => [error.property, Object.keys(error.constraints ?? {})]));
}

describe.each([CreateEventOccurrenceDto, UpdateEventOccurrenceDto])('%p', (dtoClass) => {
  // The column is a 32-bit Int, so a larger number answers 400 naming the
  // field rather than failing the write as a 500 (#1444).
  it('refuses a sortOrder past the 32-bit column range (#1444)', async () => {
    await expect(constraintsByProperty(dtoClass, { sortOrder: 2 ** 31 })).resolves.toEqual({ sortOrder: ['max'] });
    await expect(constraintsByProperty(dtoClass, { sortOrder: 2 ** 31 - 1 })).resolves.toEqual({});
  });
});
