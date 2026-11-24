import { plainToInstance } from 'class-transformer';
import type { ValidationError } from 'class-validator';
import { validate } from 'class-validator';
import { CreateApiKeyDto } from './create-api-key.dto';

/**
 * Transforms and validates a body as the global pipe does (apps/api/src/main.ts):
 * implicit conversion on, unknown keys refused. Without implicit conversion a
 * spec would pass against a DTO that reads `"90"` as 90 or `"false"` as true
 * (#1418).
 */
async function check(body: Record<string, unknown>): Promise<{ dto: CreateApiKeyDto; errors: ValidationError[] }> {
  const dto = plainToInstance(CreateApiKeyDto, body, { enableImplicitConversion: true });
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

describe('CreateApiKeyDto (#1418)', () => {
  it('accepts a full create body and keeps its values', async () => {
    const { dto, errors } = await check({
      name: '  Home Assistant  ',
      scopes: [{ slug: 'read:game' }, { slug: 'update:game', resourceId: 'game-1' }],
      expiresInDays: 30,
      confirmCritical: true,
    });

    expect(errors).toEqual([]);
    expect(dto).toEqual({
      name: 'Home Assistant',
      scopes: [{ slug: 'read:game' }, { slug: 'update:game', resourceId: 'game-1' }],
      expiresInDays: 30,
      confirmCritical: true,
    });
  });

  it('accepts the everything preset', async () => {
    const { dto, errors } = await check({ name: 'Backup', preset: 'everything' });

    expect(errors).toEqual([]);
    expect(dto.preset).toBe('everything');
  });

  describe('name', () => {
    it('is required', async () => {
      expect(failed((await check({})).errors)).toEqual(['name']);
    });

    // Trimmed first, so a name of only spaces is empty and refused before
    // better-auth is called.
    it('refuses a name of only spaces', async () => {
      expect(failed((await check({ name: '   ' })).errors)).toEqual(['name']);
    });

    it('accepts 32 characters and refuses 33', async () => {
      expect((await check({ name: 'a'.repeat(32) })).errors).toEqual([]);
      expect(failed((await check({ name: 'a'.repeat(33) })).errors)).toEqual(['name']);
    });

    // Implicit conversion would make 5 the name '5'.
    it('refuses a number', async () => {
      expect(failed((await check({ name: 5 })).errors)).toEqual(['name']);
    });
  });

  describe('expiresInDays', () => {
    // The range is the service's 422, so a client hears it with the range.
    it('accepts any whole number, leaving the range to the service', async () => {
      expect((await check({ name: 'k', expiresInDays: 0 })).errors).toEqual([]);
      expect((await check({ name: 'k', expiresInDays: 366 })).errors).toEqual([]);
    });

    it('refuses a fraction', async () => {
      expect(failed((await check({ name: 'k', expiresInDays: 1.5 })).errors)).toEqual(['expiresInDays']);
    });

    // Implicit conversion would make the string '90' the number 90.
    it('refuses a number sent as a string', async () => {
      expect(failed((await check({ name: 'k', expiresInDays: '90' })).errors)).toEqual(['expiresInDays']);
    });
  });

  describe('preset', () => {
    it("refuses any preset but 'everything'", async () => {
      expect(failed((await check({ name: 'k', preset: 'all' })).errors)).toEqual(['preset']);
    });
  });

  describe('confirmCritical', () => {
    // Implicit conversion would make the string 'false' true, which would
    // confirm a Critical permission the owner meant to refuse.
    it("refuses the string 'false'", async () => {
      const { dto, errors } = await check({ name: 'k', confirmCritical: 'false' });

      expect(failed(errors)).toEqual(['confirmCritical']);
      expect(dto.confirmCritical).toBe('false');
    });
  });

  describe('scopes', () => {
    it('validates each key scope', async () => {
      const { errors } = await check({ name: 'k', scopes: [{ slug: 'read:game' }, { slug: 5 }, { resourceId: 7 }] });

      expect(failed(errors)).toEqual(['scopes.1.slug', 'scopes.2.slug', 'scopes.2.resourceId']);
    });

    // A key scope is `{ slug, resourceId? }`: the server takes its type from the permission.
    it('refuses an unknown key inside a key scope', async () => {
      const { errors } = await check({ name: 'k', scopes: [{ slug: 'read:game', resourceType: 'Game' }] });

      expect(failed(errors)).toEqual(['scopes.0.resourceType']);
    });

    it('refuses a key scope that is not an object', async () => {
      expect(failed((await check({ name: 'k', scopes: ['read:game'] })).errors)).toEqual(['scopes.0']);
    });

    it('refuses more than 500 key scopes', async () => {
      const scopes = Array.from({ length: 501 }, (_, index) => ({ slug: `read:thing_${index}` }));

      expect(failed((await check({ name: 'k', scopes })).errors)).toEqual(['scopes']);
    });
  });

  it('refuses a NUL character in a name and in a scope slug or resource id, which Postgres cannot store (#1418)', async () => {
    expect(failed((await check({ name: 'a\u0000b' })).errors)).toEqual(['name']);
    expect(failed((await check({ name: 'k', scopes: [{ slug: 'read:ga\u0000me' }] })).errors)).toEqual([
      'scopes.0.slug',
    ]);
    expect(failed((await check({ name: 'k', scopes: [{ slug: 'read:game', resourceId: 'g\u0000' }] })).errors)).toEqual(
      ['scopes.0.resourceId'],
    );
  });

  it('refuses a key the DTO does not declare', async () => {
    expect(failed((await check({ name: 'k', enabled: false })).errors)).toEqual(['enabled']);
  });
});
