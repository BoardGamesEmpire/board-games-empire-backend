import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateEventDto } from './create-event.dto';

type PlainPayload = Record<string, unknown>;

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function propertiesWithErrors(payload: PlainPayload): Promise<string[]> {
  const dto = plainToInstance(CreateEventDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return errors.map((error) => error.property);
}

describe('CreateEventDto', () => {
  it.each([[{}], [{ householdId: null }], [{ householdId: 'hh-1' }]])(
    'accepts an event outside any household or in a named one: %p',
    async (household) => {
      await expect(propertiesWithErrors({ title: 'Game night', ...household })).resolves.toEqual([]);
    },
  );

  // The create check reads an empty string as a household id, which no
  // household role matches, so it would answer 403 to a request that only
  // meant "no household".
  it('rejects an empty householdId', async () => {
    await expect(propertiesWithErrors({ title: 'Game night', householdId: '' })).resolves.toEqual(['householdId']);
  });
});
