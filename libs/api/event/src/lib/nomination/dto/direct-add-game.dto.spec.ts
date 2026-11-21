import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DirectAddGameDto } from './direct-add-game.dto';

type PlainPayload = Record<string, unknown>;

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function constraintsByProperty(payload: PlainPayload): Promise<Record<string, string[]>> {
  const dto = plainToInstance(DirectAddGameDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return Object.fromEntries(errors.map((error) => [error.property, Object.keys(error.constraints ?? {})]));
}

const REQUIRED = { platformGameId: 'pg-1', suppliedById: 'list-1' };

describe('DirectAddGameDto', () => {
  // Each column is a 32-bit Int, so a larger number answers 400 naming the
  // field rather than failing the write as a 500 (#1444).
  it.each(['maxPlayTime', 'sortOrder'])('refuses %s past the 32-bit column range (#1444)', async (field) => {
    await expect(constraintsByProperty({ ...REQUIRED, [field]: 2 ** 31 })).resolves.toEqual({ [field]: ['max'] });
    await expect(constraintsByProperty({ ...REQUIRED, [field]: 2 ** 31 - 1 })).resolves.toEqual({});
  });
});
