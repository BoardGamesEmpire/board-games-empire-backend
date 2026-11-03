import { ResourceType } from '@bge/database';
import { validationCatalogKeys } from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UserAccessQueryDto } from './user-access-query.dto';

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function parse(payload: Record<string, unknown>) {
  const dto = plainToInstance(UserAccessQueryDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return { dto, errors, failed: errors.map((error) => error.property) };
}

describe('UserAccessQueryDto resourceTypes', () => {
  it('reads a comma-separated list (#757)', async () => {
    const { dto, failed } = await parse({ resourceTypes: 'DataGateway,UserProfile' });

    expect(failed).toEqual([]);
    expect(dto.resourceTypes).toEqual([ResourceType.DataGateway, ResourceType.UserProfile]);
  });

  it('reads a repeated parameter (#757)', async () => {
    const { dto, failed } = await parse({ resourceTypes: ['DataGateway', 'UserProfile'] });

    expect(failed).toEqual([]);
    expect(dto.resourceTypes).toEqual([ResourceType.DataGateway, ResourceType.UserProfile]);
  });

  // The route answers only the resource types it is asked about (#757).
  it('refuses a missing list (#757)', async () => {
    await expect(parse({})).resolves.toEqual(expect.objectContaining({ failed: ['resourceTypes'] }));
  });

  // `?resourceTypes=` reads as an empty list, which would answer nothing at all (#757).
  it('refuses an empty list (#757)', async () => {
    await expect(parse({ resourceTypes: '' })).resolves.toEqual(expect.objectContaining({ failed: ['resourceTypes'] }));
  });

  it('refuses a value that is no resource type, naming a catalog key (#757)', async () => {
    const { errors, failed } = await parse({ resourceTypes: 'DataGateway,NotAType' });

    expect(failed).toEqual(['resourceTypes']);
    expect(validationCatalogKeys(errors)).toEqual({ 'resourceTypes.isIn': 'validation.each.isIn' });
  });
});
