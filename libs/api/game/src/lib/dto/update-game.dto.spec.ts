import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateGameDto } from './update-game.dto';

type PlainPayload = Record<string, unknown>;

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function propertiesWithErrors(payload: PlainPayload): Promise<string[]> {
  const dto = plainToInstance(UpdateGameDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return errors.map((error) => error.property);
}

describe('UpdateGameDto', () => {
  // PartialType's IsOptional skipped null as well as a missing key, so a null
  // reached the non-nullable title column as a 500 (#1275).
  it('refuses null for title, which a game always has (#1275)', async () => {
    await expect(propertiesWithErrors({ title: null })).resolves.toEqual(['title']);
  });

  it('accepts a patch without title (#1275)', async () => {
    await expect(propertiesWithErrors({ subtitle: 'The Card Game' })).resolves.toEqual([]);
  });

  it.each(['subtitle', 'minPlayers', 'complexity'])('accepts null for %s, which clears it (#1275)', async (field) => {
    await expect(propertiesWithErrors({ [field]: null })).resolves.toEqual([]);
  });
});
