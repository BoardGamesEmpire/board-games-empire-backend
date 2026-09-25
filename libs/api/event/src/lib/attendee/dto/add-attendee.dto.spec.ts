import { SystemRole } from '@bge/database';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AddAttendeeDto } from './add-attendee.dto';

type PlainPayload = Record<string, unknown>;

const VALID_PAYLOAD: PlainPayload = { userId: 'user-2' };

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
