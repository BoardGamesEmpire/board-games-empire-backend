import { SystemRole } from '@bge/database';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  HOUSEHOLD_INVITE_MAX_MESSAGE_LENGTH,
  HOUSEHOLD_INVITE_MAX_NAME_LENGTH,
} from '../constants/household.constants';
import { CreateHouseholdInviteDto } from './create-household-invite.dto';

type PlainPayload = Record<string, unknown>;

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
function instantiate(payload: PlainPayload): CreateHouseholdInviteDto {
  return plainToInstance(CreateHouseholdInviteDto, payload, { enableImplicitConversion: true });
}

async function propertiesWithErrors(payload: PlainPayload): Promise<string[]> {
  const errors = await validate(instantiate(payload), { whitelist: true, forbidNonWhitelisted: true });

  return errors.map((error) => error.property);
}

describe('CreateHouseholdInviteDto', () => {
  it.each([
    ['an invite by id', { inviteeId: 'user-2' }],
    ['an invite by address', { inviteeEmail: 'sam@example.test' }],
    [
      'a fully populated invite',
      { inviteeEmail: 'sam@example.test', inviteeName: 'Sam', role: SystemRole.HouseholdAdmin, message: 'Join us' },
    ],
  ])('accepts %s', async (_label, payload) => {
    await expect(propertiesWithErrors(payload)).resolves.toEqual([]);
  });

  // Exactly one of the two is the service's rule, since it spans two fields;
  // the DTO leaves both optional.
  it('leaves the choice of invitee field to the service', async () => {
    await expect(propertiesWithErrors({})).resolves.toEqual([]);
  });

  it('refuses an empty id', async () => {
    await expect(propertiesWithErrors({ inviteeId: '' })).resolves.toEqual(['inviteeId']);
  });

  it('refuses something that is not an address', async () => {
    await expect(propertiesWithErrors({ inviteeEmail: 'not-an-address' })).resolves.toEqual(['inviteeEmail']);
  });

  it('trims a padded address before checking it', async () => {
    expect(instantiate({ inviteeEmail: '  sam@example.test ' }).inviteeEmail).toBe('sam@example.test');
    await expect(propertiesWithErrors({ inviteeEmail: '  sam@example.test ' })).resolves.toEqual([]);
  });

  it('trims a name, and refuses one that is blank', async () => {
    expect(instantiate({ inviteeId: 'user-2', inviteeName: '  Sam ' }).inviteeName).toBe('Sam');
    await expect(propertiesWithErrors({ inviteeId: 'user-2', inviteeName: '' })).resolves.toEqual(['inviteeName']);
    await expect(propertiesWithErrors({ inviteeId: 'user-2', inviteeName: '   ' })).resolves.toEqual(['inviteeName']);
  });

  it.each([SystemRole.HouseholdAdmin, SystemRole.HouseholdMember, SystemRole.HouseholdGuest])(
    'offers %s',
    async (role) => {
      await expect(propertiesWithErrors({ inviteeId: 'user-2', role })).resolves.toEqual([]);
    },
  );

  it.each([SystemRole.HouseholdOwner, SystemRole.Admin, SystemRole.EventHost])('refuses to offer %s', async (role) => {
    await expect(propertiesWithErrors({ inviteeId: 'user-2', role })).resolves.toEqual(['role']);
  });

  it.each([
    ['inviteeName', HOUSEHOLD_INVITE_MAX_NAME_LENGTH],
    ['message', HOUSEHOLD_INVITE_MAX_MESSAGE_LENGTH],
  ])('caps %s at %i characters', async (field, cap) => {
    await expect(propertiesWithErrors({ inviteeId: 'user-2', [field]: 'x'.repeat(cap) })).resolves.toEqual([]);
    await expect(propertiesWithErrors({ inviteeId: 'user-2', [field]: 'x'.repeat(cap + 1) })).resolves.toEqual([field]);
  });

  it('refuses a client-supplied expiry, which the lib sets', async () => {
    await expect(propertiesWithErrors({ inviteeId: 'user-2', expiresAt: '2030-01-01T00:00:00Z' })).resolves.toEqual([
      'expiresAt',
    ]);
  });
});
