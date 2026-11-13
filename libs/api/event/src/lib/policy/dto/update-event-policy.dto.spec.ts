import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateEventPolicyDto } from './update-event-policy.dto';

type PlainPayload = Record<string, unknown>;

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function propertiesWithErrors(payload: PlainPayload): Promise<string[]> {
  const dto = plainToInstance(UpdateEventPolicyDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return errors.map((error) => error.property);
}

describe('UpdateEventPolicyDto', () => {
  // The column can't be null, so `null` answers 400 naming the field rather
  // than reaching the write as a 500 (#796).
  it('refuses null on a column that cannot be null (#796)', async () => {
    await expect(propertiesWithErrors({ allowMemberInvites: null })).resolves.toEqual(['allowMemberInvites']);
  });

  it('accepts null on a nullable column, which clears it (#796)', async () => {
    await expect(propertiesWithErrors({ maxAttendees: null })).resolves.toEqual([]);
  });

  it('refuses a game addition mode that does not exist (#796)', async () => {
    await expect(propertiesWithErrors({ gameAdditionMode: 'Nope' })).resolves.toEqual(['gameAdditionMode']);
  });

  it('refuses allowedCategoryIds, which this route does not set yet (#796)', async () => {
    await expect(propertiesWithErrors({ allowedCategoryIds: [] })).resolves.toEqual(['allowedCategoryIds']);
  });
});
