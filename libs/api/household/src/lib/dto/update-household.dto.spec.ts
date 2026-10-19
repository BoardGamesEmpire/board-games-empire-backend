import { MemberInvitePolicy, Reach } from '@bge/database';
import { DECORATORS } from '@nestjs/swagger';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateHouseholdDto } from './update-household.dto';

type PlainPayload = Record<string, unknown>;

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function propertiesWithErrors(payload: PlainPayload): Promise<string[]> {
  const dto = plainToInstance(UpdateHouseholdDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return errors.map((error) => error.property);
}

describe('UpdateHouseholdDto', () => {
  it('accepts every field a household edit may change', async () => {
    const payload: PlainPayload = {
      name: 'Renamed',
      reach: Reach.Friends,
      description: 'Board game night crew',
      image: 'https://example.test/avatar.png',
      language: 'pt-BR',
    };

    await expect(propertiesWithErrors(payload)).resolves.toEqual([]);
  });

  // The rungs a household read rule serves, and no others. `Public` waits on
  // #231 (#495), and null would reach a non-nullable column as a 500.
  it.each([['Public'], ['FriendsOfFriends'], ['Household'], [null]])('rejects reach %p', async (reach) => {
    await expect(propertiesWithErrors({ reach })).resolves.toEqual(['reach']);
  });

  it('rejects clientRequestId, which belongs to the create it keys (#534)', async () => {
    // The key is how a retried create finds the row it already made. An edit
    // that rewrites it strands that retry, which then makes a second household;
    // one that copies another of the creator's keys trips the unique. Refused
    // rather than stripped, so a client sending it learns the field is not
    // editable instead of believing the write took.
    await expect(propertiesWithErrors({ name: 'Renamed', clientRequestId: 'key-1' })).resolves.toEqual([
      'clientRequestId',
    ]);
  });

  it('leaves clientRequestId out of the published update schema', () => {
    // What the generated client is built from. A field the server refuses must
    // not appear in the schema it publishes for the request.
    const published: string[] = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES_ARRAY,
      UpdateHouseholdDto.prototype,
    );

    expect(published).toEqual(expect.arrayContaining([':name', ':reach', ':language']));
    expect(published).not.toContain(':clientRequestId');
  });

  describe('settings (#166)', () => {
    it.each([MemberInvitePolicy.Off, MemberInvitePolicy.NeedsApproval, MemberInvitePolicy.Direct])(
      'accepts the member invite policy %s',
      async (memberInvitePolicy) => {
        await expect(propertiesWithErrors({ settings: { memberInvitePolicy } })).resolves.toEqual([]);
      },
    );

    it('refuses a policy that does not exist, and a setting it does not know', async () => {
      await expect(propertiesWithErrors({ settings: { memberInvitePolicy: 'Sometimes' } })).resolves.toEqual([
        'settings',
      ]);
      await expect(propertiesWithErrors({ settings: { joinPolicy: 'Open' } })).resolves.toEqual(['settings']);
    });

    it('refuses a null policy, since no setting can be unset', async () => {
      // The column has no null, so one let through would fail at the write
      // instead of answering 400.
      await expect(propertiesWithErrors({ settings: { memberInvitePolicy: null } })).resolves.toEqual(['settings']);
    });

    it('accepts settings that leave the policy out', async () => {
      await expect(propertiesWithErrors({ name: 'Renamed', settings: {} })).resolves.toEqual([]);
    });

    it('refuses settings that are not an object', async () => {
      await expect(propertiesWithErrors({ settings: 'Direct' })).resolves.toEqual(['settings']);
    });
  });
});
