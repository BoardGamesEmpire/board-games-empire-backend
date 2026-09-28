import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateEventDto } from './update-event.dto';

type PlainPayload = Record<string, unknown>;

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function propertiesWithErrors(payload: PlainPayload): Promise<string[]> {
  const dto = plainToInstance(UpdateEventDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return errors.map((error) => error.property);
}

describe('UpdateEventDto', () => {
  it('accepts a patch of the fields an update may change', async () => {
    await expect(propertiesWithErrors({ title: 'Renamed', visibility: 'Public' })).resolves.toEqual([]);
  });

  // An event's household is set when it is created and never after (#454).
  // Moving it would hand the event to one household's managers and take it
  // from another's, and neither side's consent is a grant a PATCH can check.
  it.each([['hh-2'], [null]])(
    'rejects householdId %p, so a PATCH neither moves nor detaches an event',
    async (householdId) => {
      await expect(propertiesWithErrors({ householdId })).resolves.toEqual(['householdId']);
    },
  );
});
