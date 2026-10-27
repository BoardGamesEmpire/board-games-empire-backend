import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { HOUSEHOLD_BAN_MAX_REASON_LENGTH } from '../constants/household.constants';
import { UpdateHouseholdBanDto } from './update-household-ban.dto';

type PlainPayload = Record<string, unknown>;

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function propertiesWithErrors(payload: PlainPayload): Promise<string[]> {
  const dto = plainToInstance(UpdateHouseholdBanDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return errors.map((error) => error.property);
}

describe('UpdateHouseholdBanDto accepts a reason or null, and refuses a missing, empty or overlong one (#782)', () => {
  it.each([
    ['a reason', { reason: 'Kept taking the good meeples' }],
    ['a reason of the longest length', { reason: 'r'.repeat(HOUSEHOLD_BAN_MAX_REASON_LENGTH) }],
    // `null` clears the reason.
    ['null', { reason: null }],
  ])('accepts %s', async (_label, payload) => {
    await expect(propertiesWithErrors(payload)).resolves.toEqual([]);
  });

  it.each([
    // Clearing the reason is said with `null`, so a body that names none
    // changes nothing and is refused.
    ['a missing reason', {}],
    ['an empty reason', { reason: '' }],
    ['an overlong reason', { reason: 'r'.repeat(HOUSEHOLD_BAN_MAX_REASON_LENGTH + 1) }],
    ['a reason that is not text', { reason: 42 }],
  ])('refuses %s', async (_label, payload) => {
    await expect(propertiesWithErrors(payload)).resolves.toEqual(['reason']);
  });
});
