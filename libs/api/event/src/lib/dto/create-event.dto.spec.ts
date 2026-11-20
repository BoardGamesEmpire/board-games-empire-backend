import { Reach } from '@bge/database';
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

  // Every rung an event read permission serves (#496, #497).
  it.each([Reach.Private, Reach.Friends, Reach.FriendsOfFriends, Reach.ExtendedNetwork, Reach.Public])(
    'accepts reach %s',
    async (reach) => {
      await expect(propertiesWithErrors({ title: 'Game night', reach })).resolves.toEqual([]);
    },
  );

  it.each([[''], ['   '], [null]])('rejects the title %p (#1404)', async (title) => {
    await expect(propertiesWithErrors({ title })).resolves.toEqual(['title']);
  });

  it('trims the title (#1404)', async () => {
    const dto = plainToInstance(CreateEventDto, { title: '  Game night ' });

    await expect(validate(dto, { whitelist: true, forbidNonWhitelisted: true })).resolves.toEqual([]);
    expect(dto.title).toBe('Game night');
  });

  // IsOptional skipped null as well as a missing key, so a null for either
  // non-nullable column passed the pipe and answered 500 at the database
  // (#1404).
  it.each([['type'], ['schedulingMode']])('rejects a null %s (#1404)', async (field) => {
    await expect(propertiesWithErrors({ title: 'Game night', [field]: null })).resolves.toEqual([field]);
  });

  // Left out, each stays undefined, so the column default applies:
  // CasualGathering and Fixed (#1404).
  it('accepts an event that leaves out type and schedulingMode (#1404)', async () => {
    const dto = plainToInstance(CreateEventDto, { title: 'Game night' });

    await expect(validate(dto, { whitelist: true, forbidNonWhitelisted: true })).resolves.toEqual([]);
    expect(dto.type).toBeUndefined();
    expect(dto.schedulingMode).toBeUndefined();
  });

  // IsOptional skipped null as well as a missing key, and the service reads a
  // null invite list as a list, which threw a TypeError as a 500 (#1275).
  it('refuses null for inviteUserIds, which the event has no way to read (#1275)', async () => {
    await expect(propertiesWithErrors({ title: 'Game night', inviteUserIds: null })).resolves.toEqual([
      'inviteUserIds',
    ]);
  });

  it('accepts a create that leaves inviteUserIds out, so no one is invited (#1275)', async () => {
    await expect(propertiesWithErrors({ title: 'Game night', inviteUserIds: undefined })).resolves.toEqual([]);
  });

  describe('policy fields whose columns cannot be null (#1275)', () => {
    async function policyErrors(policy: PlainPayload) {
      const dto = plainToInstance(CreateEventDto, { title: 'Game night', policy }, { enableImplicitConversion: true });

      return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    }

    it.each([
      'allowMemberInvites',
      'allowGuestInvites',
      'requireHostApprovalToJoin',
      'allowSpectators',
      'strictCapacity',
      'restrictToAttendeePool',
      'restrictToGameCategories',
      'gameAdditionMode',
      'voteThresholdType',
      'voteQuorumType',
      'voteEligibility',
      'interestedWeight',
    ])('refuses null for policy.%s (#1275)', async (field) => {
      const errors = await policyErrors({ [field]: null });

      // A nested error surfaces on its parent.
      expect(errors.map((error) => error.property)).toEqual(['policy']);
      expect(errors[0].children?.map((child) => child.property)).toEqual([field]);
    });

    it('accepts a policy that leaves them all out, so their defaults apply (#1275)', async () => {
      await expect(policyErrors({})).resolves.toEqual([]);
    });

    it.each(['maxAttendees', 'maxTotalParticipants', 'fillerMaxPlayTime', 'votingWindowHours'])(
      'accepts null for policy.%s, which leaves it empty (#1275)',
      async (field) => {
        await expect(policyErrors({ [field]: null })).resolves.toEqual([]);
      },
    );
  });

  // The create check reads an empty string as a household id, which no
  // household role matches, so it would answer 403 to a request that only
  // meant "no household".
  it('rejects an empty householdId', async () => {
    await expect(propertiesWithErrors({ title: 'Game night', householdId: '' })).resolves.toEqual(['householdId']);
  });

  describe('clientRequestId (#252)', () => {
    it('trims a padded key, so a retry that differs only in padding replays the same event', async () => {
      const dto = plainToInstance(CreateEventDto, { title: 'Game night', clientRequestId: '  k ' });

      await expect(validate(dto, { whitelist: true, forbidNonWhitelisted: true })).resolves.toEqual([]);
      expect(dto.clientRequestId).toBe('k');
    });

    it('rejects a blank key rather than reading it as none', async () => {
      await expect(propertiesWithErrors({ title: 'Game night', clientRequestId: '' })).resolves.toEqual([
        'clientRequestId',
      ]);
    });
  });

  // The lists are optional, and null is refused as a value (#1268).
  it('accepts the allowed platform lists on a policy, and refuses a type or null that is not one (#1268)', async () => {
    const policy = (fields: PlainPayload) => ({ title: 'Game night', policy: fields });

    await expect(
      propertiesWithErrors(policy({ allowedPlatformTypes: ['Tabletop', 'PC'], allowedPlatformIds: ['plat-1'] })),
    ).resolves.toEqual([]);
    await expect(propertiesWithErrors(policy({ allowedPlatformTypes: ['Nope'] }))).resolves.toEqual(['policy']);
    await expect(propertiesWithErrors(policy({ allowedPlatformIds: null }))).resolves.toEqual(['policy']);
  });

  // The ids reach the existence check whether or not categories are
  // restricted, so they are checked whenever they are sent: a bare string
  // would be read as its characters, and anything else would reach the
  // database (#1268).
  it.each<[string, unknown]>([
    ['null', null],
    ['a bare string', 'cat-1'],
    ['a list holding a number', [1]],
  ])('refuses allowed category ids that are %s, whether or not categories are restricted (#1268)', async (_, ids) => {
    for (const restrictToGameCategories of [undefined, false, true]) {
      await expect(
        propertiesWithErrors({ title: 'Game night', policy: { restrictToGameCategories, allowedCategoryIds: ids } }),
      ).resolves.toEqual(['policy']);
    }
  });

  it('accepts allowed category ids with categories left unrestricted, and requires them when restricted (#1268)', async () => {
    const policy = (fields: PlainPayload) => ({ title: 'Game night', policy: fields });

    await expect(propertiesWithErrors(policy({ allowedCategoryIds: ['cat-1'] }))).resolves.toEqual([]);
    await expect(propertiesWithErrors(policy({ restrictToGameCategories: true }))).resolves.toEqual(['policy']);
  });

  // The column can't be null, and a create that leaves it out takes Any (#796).
  it('accepts an occurrence override scope on a policy, and refuses null or one that does not exist (#796)', async () => {
    const policy = (occurrenceOverrideScope: unknown) => ({ title: 'Game night', policy: { occurrenceOverrideScope } });

    await expect(propertiesWithErrors(policy('TightenOnly'))).resolves.toEqual([]);
    await expect(propertiesWithErrors(policy(null))).resolves.toEqual(['policy']);
    await expect(propertiesWithErrors(policy('Loose'))).resolves.toEqual(['policy']);
  });
});
