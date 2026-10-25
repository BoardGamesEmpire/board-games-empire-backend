import { DECORATORS } from '@nestjs/swagger';
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
    await expect(propertiesWithErrors({ title: 'Renamed', reach: 'Private' })).resolves.toEqual([]);
  });

  // The rungs an event read rule serves, friends of friends included (#496),
  // and no others.
  it.each([['Public'], ['FriendsOfFriends'], ['Friends'], ['Private']])('accepts reach %p', async (reach) => {
    await expect(propertiesWithErrors({ reach })).resolves.toEqual([]);
  });

  it.each([['Household'], [null]])('rejects reach %p', async (reach) => {
    await expect(propertiesWithErrors({ reach })).resolves.toEqual(['reach']);
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

  it('rejects clientRequestId, which belongs to the create it keys (#252, #534)', async () => {
    // The key is how a retried create finds the event it already made. An edit
    // that rewrites it strands that retry, which then makes a second event; one
    // that copies another of the creator's keys trips the unique. Refused rather
    // than stripped, so a client sending it learns the field is not editable.
    await expect(propertiesWithErrors({ title: 'Renamed', clientRequestId: 'key-1' })).resolves.toEqual([
      'clientRequestId',
    ]);
  });

  it('leaves clientRequestId out of the published update schema', () => {
    // What the generated client is built from. A field the server refuses must
    // not appear in the schema it publishes for the request.
    const published: string[] = Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES_ARRAY, UpdateEventDto.prototype);

    expect(published).toEqual(expect.arrayContaining([':title', ':reach']));
    expect(published).not.toContain(':clientRequestId');
  });
});
