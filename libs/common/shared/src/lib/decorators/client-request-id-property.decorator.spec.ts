import { DECORATORS } from '@nestjs/swagger';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ClientRequestIdProperty, MAX_CLIENT_REQUEST_ID_LENGTH } from './client-request-id-property.decorator';

class CreateDto {
  @ClientRequestIdProperty('event')
  clientRequestId?: string;
}

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function validated(payload: Record<string, unknown>) {
  const dto = plainToInstance(CreateDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return { dto, properties: errors.map((error) => error.property) };
}

describe('ClientRequestIdProperty (#252)', () => {
  it('accepts the key left out, for a create nobody will retry', async () => {
    await expect(validated({})).resolves.toMatchObject({ properties: [] });
  });

  it('trims a padded key, so a retry that differs only in padding finds the same row (#252)', async () => {
    const { dto, properties } = await validated({ clientRequestId: '  k ' });

    expect(properties).toEqual([]);
    expect(dto.clientRequestId).toBe('k');
  });

  it(`accepts a key of exactly ${MAX_CLIENT_REQUEST_ID_LENGTH} characters`, async () => {
    await expect(validated({ clientRequestId: 'k'.repeat(MAX_CLIENT_REQUEST_ID_LENGTH) })).resolves.toMatchObject({
      properties: [],
    });
  });

  // A blank key answers 400 rather than reaching the service, where it would be
  // read as no key and silently cost the caller its retry guarantee. The trim
  // runs before the length check, so whitespace alone is blank too.
  it.each([[''], ['   '], ['k'.repeat(MAX_CLIENT_REQUEST_ID_LENGTH + 1)]])('rejects %p', async (clientRequestId) => {
    await expect(validated({ clientRequestId })).resolves.toMatchObject({ properties: ['clientRequestId'] });
  });

  // The global pipe's implicit conversion would otherwise accept these as the
  // strings '5', 'true' and '[object Object]', and every create keyed with an
  // object would share the last one, each replaying the first (#252).
  it.each([[5], [true], [{ key: 'k' }], [['k']]])('rejects the non-string %p', async (clientRequestId) => {
    await expect(validated({ clientRequestId })).resolves.toMatchObject({ properties: ['clientRequestId'] });
  });

  it('publishes its bounds, and names the record a replay returns', () => {
    const published: Record<string, unknown> = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      CreateDto.prototype,
      'clientRequestId',
    );

    expect(published).toMatchObject({ required: false, minLength: 1, maxLength: 128 });
    expect(published['description']).toEqual(expect.stringContaining('ORIGINAL event'));
  });

  // The route's own permission check runs before the replay lookup, so a key
  // is no way around a ban, and the description must not promise one (#251).
  it('tells the client that a repeat is still refused to a user refused the create since', () => {
    const published: Record<string, unknown> = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      CreateDto.prototype,
      'clientRequestId',
    );

    expect(published['description']).toEqual(expect.stringContaining('is refused the repeat too'));
  });

  it("adds the route's sentence on what a repeat does not do again", () => {
    class NotifyingCreateDto {
      @ClientRequestIdProperty('report', 'A repeat does not forward the report to its sinks again.')
      clientRequestId?: string;
    }

    const published: Record<string, unknown> = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      NotifyingCreateDto.prototype,
      'clientRequestId',
    );

    expect(published['description']).toEqual(
      expect.stringContaining('too. A repeat does not forward the report to its sinks again. The repeat'),
    );
  });
});
