import { plainToInstance } from 'class-transformer';
import type { ValidationError } from 'class-validator';
import { validate } from 'class-validator';
import { UpdateApiKeyDto } from './update-api-key.dto';

/**
 * Transforms and validates a body as the global pipe does (apps/api/src/main.ts):
 * implicit conversion on, unknown keys refused (#1418).
 */
async function check(body: Record<string, unknown>): Promise<{ dto: UpdateApiKeyDto; errors: ValidationError[] }> {
  const dto = plainToInstance(UpdateApiKeyDto, body, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return { dto, errors };
}

/** The properties that failed, nested ones as `scopes.0.slug`. */
function failed(errors: ValidationError[], parent = ''): string[] {
  return errors.flatMap((error) => {
    const path = parent ? `${parent}.${error.property}` : error.property;

    return error.children?.length ? failed(error.children, path) : [path];
  });
}

describe('UpdateApiKeyDto (#1418)', () => {
  // An empty edit changes nothing, and the service answers the key as it is.
  it('accepts an empty body', async () => {
    expect((await check({})).errors).toEqual([]);
  });

  it('accepts a full edit and keeps its values', async () => {
    const { dto, errors } = await check({
      name: ' Renamed ',
      scopes: [{ slug: 'read:game', resourceId: 'game-1' }],
      expiresInDays: 365,
      enabled: false,
      confirmCritical: false,
    });

    expect(errors).toEqual([]);
    expect(dto).toEqual({
      name: 'Renamed',
      scopes: [{ slug: 'read:game', resourceId: 'game-1' }],
      expiresInDays: 365,
      enabled: false,
      confirmCritical: false,
    });
  });

  // An empty list is a real edit: the key keeps no key scope.
  it('accepts an empty scope list', async () => {
    const { dto, errors } = await check({ scopes: [] });

    expect(errors).toEqual([]);
    expect(dto.scopes).toEqual([]);
  });

  it('refuses a name of only spaces, and one of 33 characters', async () => {
    expect(failed((await check({ name: '   ' })).errors)).toEqual(['name']);
    expect(failed((await check({ name: 'a'.repeat(33) })).errors)).toEqual(['name']);
  });

  it('refuses a NUL character in a name, which Postgres cannot store (#1418)', async () => {
    expect(failed((await check({ name: 'a\u0000b' })).errors)).toEqual(['name']);
  });

  it('refuses a number for a name', async () => {
    expect(failed((await check({ name: 5 })).errors)).toEqual(['name']);
  });

  it('refuses a fraction, and a number sent as a string, for expiresInDays', async () => {
    expect(failed((await check({ expiresInDays: 1.5 })).errors)).toEqual(['expiresInDays']);
    expect(failed((await check({ expiresInDays: '90' })).errors)).toEqual(['expiresInDays']);
  });

  // Implicit conversion would make the string 'false' true: a client meaning
  // to disable a key would enable it, and one refusing a Critical permission
  // would confirm it.
  it("refuses the string 'false' for enabled and confirmCritical", async () => {
    expect(failed((await check({ enabled: 'false' })).errors)).toEqual(['enabled']);
    expect(failed((await check({ confirmCritical: 'false' })).errors)).toEqual(['confirmCritical']);
  });

  // Null is not "leave as it is": a field left out is.
  it('refuses null for each field', async () => {
    const { errors } = await check({ name: null, scopes: null, expiresInDays: null, enabled: null });

    expect(failed(errors).sort()).toEqual(['enabled', 'expiresInDays', 'name', 'scopes']);
  });

  it('validates each key scope and refuses an unknown key inside one', async () => {
    const { errors } = await check({ scopes: [{ slug: 5 }, { slug: 'read:game', type: 'Game' }] });

    expect(failed(errors)).toEqual(['scopes.0.slug', 'scopes.1.type']);
  });

  // The preset is for create only: an edit names its key scopes.
  it('refuses the preset', async () => {
    expect(failed((await check({ preset: 'everything' })).errors)).toEqual(['preset']);
  });
});
