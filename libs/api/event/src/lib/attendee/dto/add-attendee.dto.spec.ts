import { SystemRole } from '@bge/database';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AddAttendeeDto } from './add-attendee.dto';

type PlainPayload = Record<string, unknown>;

/** A person without an account, added by name (#742). */
const VALID_PAYLOAD: PlainPayload = { guestName: 'Pat', guestEmail: 'pat@example.com' };

/** The event roles an attendee can be added with; `EventHost` belongs to whoever created the event. */
const ASSIGNABLE: readonly SystemRole[] = [
  SystemRole.EventParticipant,
  SystemRole.EventGuest,
  SystemRole.EventSpectator,
  SystemRole.EventCoHost,
  SystemRole.EventOrganizer,
  SystemRole.EventModerator,
];

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
function instantiate(payload: PlainPayload): AddAttendeeDto {
  return plainToInstance(AddAttendeeDto, payload, { enableImplicitConversion: true });
}

async function propertiesWithErrors(payload: PlainPayload): Promise<string[]> {
  const errors = await validate(instantiate(payload), { whitelist: true, forbidNonWhitelisted: true });

  return errors.map((error) => error.property);
}

describe('AddAttendeeDto', () => {
  it('accepts a payload with no role, which the service defaults to EventParticipant', async () => {
    await expect(propertiesWithErrors(VALID_PAYLOAD)).resolves.toEqual([]);
  });

  it('requires a name for a person added without an account (#742)', async () => {
    await expect(propertiesWithErrors({ guestEmail: 'pat@example.com' })).resolves.toEqual(['guestName']);
    await expect(propertiesWithErrors({ guestName: '', guestEmail: 'pat@example.com' })).resolves.toEqual([
      'guestName',
    ]);
  });

  // Someone with an account is invited instead (#742). A `userId` passes
  // validation alone, so the service answers it with its own code,
  // ATTENDEE_ACCOUNT_NEEDS_INVITE, rather than with a missing name.
  it('lets a userId through, for the service to refuse with its own code (#742)', async () => {
    await expect(propertiesWithErrors({ userId: 'user-2' })).resolves.toEqual([]);
  });

  it.each(ASSIGNABLE)('accepts the event role %s', async (role) => {
    await expect(propertiesWithErrors({ ...VALID_PAYLOAD, role })).resolves.toEqual([]);
  });

  // The ability factory applies whatever role an attendee row names, and an
  // unconditioned grant applies everywhere: `Owner` written here would be
  // `manage:all` for the attendee's whole session.
  it.each(Object.values(SystemRole).filter((role) => !ASSIGNABLE.includes(role)))(
    'rejects %s, which is not an event role an attendee can be given',
    async (role) => {
      await expect(propertiesWithErrors({ ...VALID_PAYLOAD, role })).resolves.toEqual(['role']);
    },
  );
});
