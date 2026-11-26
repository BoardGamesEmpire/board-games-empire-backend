import { SystemRole } from '@bge/database';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateEventInviteDto, EVENT_INVITE_MAX_MESSAGE_LENGTH } from './create-event-invite.dto';

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function propertiesWithErrors(payload: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(CreateEventInviteDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return errors.map((error) => error.property);
}

describe('CreateEventInviteDto (#742)', () => {
  it.each([
    ['a user id alone', { userId: 'user-2' }],
    ['a role and a message', { userId: 'user-2', role: SystemRole.EventCoHost, message: 'Come play' }],
  ])('accepts %s', async (_label, payload) => {
    await expect(propertiesWithErrors(payload)).resolves.toEqual([]);
  });

  it.each([
    ['no user id', {}, ['userId']],
    ['an empty user id', { userId: '' }, ['userId']],
    // The host role belongs to whoever created the event, and is never offered.
    ['the host role', { userId: 'user-2', role: SystemRole.EventHost }, ['role']],
    ['a role from outside the event', { userId: 'user-2', role: SystemRole.HouseholdOwner }, ['role']],
    [
      'a message past the limit',
      { userId: 'user-2', message: 'x'.repeat(EVENT_INVITE_MAX_MESSAGE_LENGTH + 1) },
      ['message'],
    ],
    // Invites by address are #488's.
    ['an address', { userId: 'user-2', inviteeEmail: 'sam@example.test' }, ['inviteeEmail']],
  ])('refuses %s', async (_label, payload, properties) => {
    await expect(propertiesWithErrors(payload)).resolves.toEqual(properties);
  });
});
