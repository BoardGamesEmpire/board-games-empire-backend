import { validationCatalogKeys } from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateRoleDto } from './update-role.dto';

type PlainPayload = Record<string, unknown>;

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function validateAsThePipeDoes(payload: PlainPayload) {
  const dto = plainToInstance(UpdateRoleDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return { dto, errors };
}

const keysFor = async (payload: PlainPayload) => validationCatalogKeys((await validateAsThePipeDoes(payload)).errors);

describe('UpdateRoleDto (#772)', () => {
  it('accepts a description', async () => {
    const { dto, errors } = await validateAsThePipeDoes({ description: 'Members of the household' });

    expect(errors).toEqual([]);
    expect(dto.description).toBe('Members of the household');
  });

  it('accepts null, which clears the description', async () => {
    const { dto, errors } = await validateAsThePipeDoes({ description: null });

    expect(errors).toEqual([]);
    expect(dto.description).toBeNull();
  });

  // The body is the whole edit: a role has nothing else the Owner can change
  // here, so a body without a description is a mistake, not an empty edit.
  it('refuses a body without a description', async () => {
    expect(await keysFor({})).toEqual({
      'description.isString': 'validation.isString',
      'description.notContains': 'validation.noNullCharacter',
    });
  });

  // A role's name is what every condition and the server's own code know it
  // by, and who manages it is set by the edit itself.
  it.each(['name', 'managedBy', 'grants'])('refuses %s, which is not editable', async (key) => {
    const { errors } = await validateAsThePipeDoes({ description: 'x', [key]: 'anything' });

    expect(errors.map((error) => [error.property, Object.keys(error.constraints ?? {})])).toEqual([
      [key, ['whitelistValidation']],
    ]);
  });

  // The pipe's implicit conversion makes 5 into '5' and an object into
  // '[object Object]' before IsString runs; the value as sent is judged.
  it.each([
    ['a number', 5],
    ['an object', { text: 'Members' }],
    ['an array', ['Members']],
    ['a boolean', false],
  ])('refuses %s', async (_label, description) => {
    expect(await keysFor({ description })).toEqual({
      'description.isString': 'validation.isString',
      'description.notContains': 'validation.noNullCharacter',
    });
  });

  it('refuses a NUL character, which Postgres cannot store in text', async () => {
    expect(await keysFor({ description: 'Members\u0000' })).toEqual({
      'description.notContains': 'validation.noNullCharacter',
    });
  });
});
