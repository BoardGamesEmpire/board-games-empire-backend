import { RiskLevel } from '@bge/database';
import { validationCatalogKeys } from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdatePermissionDto } from './update-permission.dto';

type PlainPayload = Record<string, unknown>;

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function validateAsThePipeDoes(payload: PlainPayload) {
  const dto = plainToInstance(UpdatePermissionDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return { dto, errors };
}

const keysFor = async (payload: PlainPayload) => validationCatalogKeys((await validateAsThePipeDoes(payload)).errors);

describe('UpdatePermissionDto (#772)', () => {
  it('accepts every editable column in one edit', async () => {
    expect(
      await keysFor({
        conditions: { createdById: '{{ user.id }}' },
        reason: 'Edit your own games',
        riskLevel: RiskLevel.High,
        retired: false,
      }),
    ).toEqual({});
  });

  // The slug names an action on a resource type, so changing either would make
  // it name something else; nothing enforces fields yet (#589); and every role
  // rule is a grant.
  it.each(['action', 'subject', 'fields', 'inverted', 'slug', 'managedBy'])(
    'refuses %s, which is not editable',
    async (key) => {
      const { errors } = await validateAsThePipeDoes({ [key]: 'anything' });

      expect(errors.map((error) => [error.property, Object.keys(error.constraints ?? {})])).toEqual([
        [key, ['whitelistValidation']],
      ]);
    },
  );

  describe('conditions', () => {
    it('keeps a condition exactly as sent: arrays, nulls and nested operators survive the pipe', async () => {
      const conditions = {
        deletedAt: null,
        OR: [{ createdById: '{{ user.id }}' }, { reach: { in: ['Public', 'Friends'] } }],
        household: { is: { members: { some: { userId: '{{ user.id }}' } } } },
        playerCount: { gte: 2 },
      };

      const { dto, errors } = await validateAsThePipeDoes({ conditions });

      expect(errors).toEqual([]);
      expect(dto.conditions).toEqual(conditions);
    });

    // Postgres cannot store a NUL in jsonb, so a write carrying one answered a
    // bare 500 whenever the probe did not run first.
    it.each([
      ['a value', { createdById: 'a\u0000b' }],
      ['a key', { 'createdBy\u0000Id': '{{ user.id }}' }],
      ['a nested list', { OR: [{ name: { in: ['ok', '\u0000'] } }] }],
    ])('refuses a NUL character in %s', async (_label, conditions) => {
      expect(await keysFor({ conditions })).toEqual({ 'conditions.noNullCharacter': 'validation.noNullCharacter' });
    });

    it('accepts an empty object, which is no condition, as the permission catalog writes one', async () => {
      expect(await keysFor({ conditions: {} })).toEqual({});
    });

    it.each([
      ['an array', [{ createdById: '{{ user.id }}' }]],
      ['a string', '{"createdById":"{{ user.id }}"}'],
      ['a number', 5],
      ['a boolean', true],
      // `{}` is how to say "no condition"; one spelling keeps null out of the column.
      ['null', null],
    ])('refuses %s', async (_label, conditions) => {
      expect(await keysFor({ conditions })).toEqual({ 'conditions.isObject': 'validation.isObject' });
    });
  });

  describe('reason', () => {
    it('accepts null, which clears the reason', async () => {
      expect(await keysFor({ reason: null })).toEqual({});
    });

    // The pipe's implicit conversion makes 5 into '5' and an object into
    // '[object Object]' before IsString runs; the value as sent is judged.
    // NotContains refuses anything that is not a string too.
    it.each([
      ['a number', 5],
      ['an object', { text: 'Edit your own games' }],
      ['an array', ['Edit your own games']],
      ['a boolean', false],
    ])('refuses %s', async (_label, reason) => {
      expect(await keysFor({ reason })).toEqual({
        'reason.isString': 'validation.isString',
        'reason.notContains': 'validation.noNullCharacter',
      });
    });

    it('refuses a NUL character, which Postgres cannot store in text', async () => {
      expect(await keysFor({ reason: 'Edit\u0000' })).toEqual({ 'reason.notContains': 'validation.noNullCharacter' });
    });
  });

  describe('riskLevel', () => {
    it.each(Object.values(RiskLevel))('accepts %s', async (riskLevel) => {
      expect(await keysFor({ riskLevel })).toEqual({});
    });

    it.each(['Severe', null, 2])('refuses %p', async (riskLevel) => {
      expect(await keysFor({ riskLevel })).toEqual({ 'riskLevel.isEnum': 'validation.isEnum' });
    });
  });

  describe('retired', () => {
    it.each([true, false])('accepts %p', async (retired) => {
      const { dto, errors } = await validateAsThePipeDoes({ retired });

      expect(errors).toEqual([]);
      expect(dto.retired).toBe(retired);
    });

    // Implicit conversion would make the string 'false' true, retiring the
    // permission the Owner meant to keep; the value as sent is judged.
    it.each(['false', 'true', 0, 1, null])('refuses %p', async (retired) => {
      expect(await keysFor({ retired })).toEqual({ 'retired.isBoolean': 'validation.isBoolean' });
    });
  });
});
