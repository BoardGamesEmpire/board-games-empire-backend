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
