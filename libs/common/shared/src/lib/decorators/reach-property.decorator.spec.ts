import { DECORATORS } from '@nestjs/swagger';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ReachProperty } from './reach-property.decorator';

const REACHES = ['Private', 'Friends'] as const;
type TestReach = (typeof REACHES)[number];

class CreateDto {
  @ReachProperty({ reaches: REACHES, description: 'Who may read it', default: 'Private' })
  reach?: TestReach;
}

class UpdateDto {
  @ReachProperty({ reaches: REACHES, description: 'Who may read it' })
  reach?: TestReach;
}

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function propertiesWithErrors(payload: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(plainToInstance(CreateDto, payload), { whitelist: true, forbidNonWhitelisted: true });

  return errors.map((error) => error.property);
}

const published = (Dto: new () => object): Record<string, unknown> =>
  Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES, Dto.prototype, 'reach');

describe('ReachProperty', () => {
  it.each(REACHES)('accepts %s, a rung it was given', async (reach) => {
    await expect(propertiesWithErrors({ reach })).resolves.toEqual([]);
  });

  it('accepts the field left out, so the column default applies', async () => {
    await expect(propertiesWithErrors({})).resolves.toEqual([]);
  });

  // A rung it wasn't given would claim readers no rule serves, and null would
  // reach a non-nullable column as a 500.
  it.each([['Public'], ['private'], [null], [1]])('rejects %p', async (reach) => {
    await expect(propertiesWithErrors({ reach })).resolves.toEqual(['reach']);
  });

  it('publishes the rungs it accepts, and a default only when given one', () => {
    expect(published(CreateDto)).toMatchObject({
      required: false,
      enum: ['Private', 'Friends'],
      default: 'Private',
      description: 'Who may read it',
    });
    expect(published(UpdateDto)).not.toHaveProperty('default');
  });
});
