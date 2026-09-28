import { Visibility } from '@bge/database';
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
      visibility: Visibility.Friends,
      description: 'Board game night crew',
      image: 'https://example.test/avatar.png',
      language: 'pt-BR',
    };

    await expect(propertiesWithErrors(payload)).resolves.toEqual([]);
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

    expect(published).toEqual(expect.arrayContaining([':name', ':visibility', ':language']));
    expect(published).not.toContain(':clientRequestId');
  });
});
