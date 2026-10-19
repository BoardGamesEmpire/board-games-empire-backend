import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateDataGatewayDto } from './update-data-gateway.dto';

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function constraintsFailed(payload: Record<string, unknown>): Promise<Record<string, string[]>> {
  const dto = plainToInstance(UpdateDataGatewayDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return Object.fromEntries(errors.map((error) => [error.property, Object.keys(error.constraints ?? {})]));
}

// #715: an admin switches capabilities off by sending the whole list.
describe('UpdateDataGatewayDto disabledCapabilities', () => {
  it('accepts an empty list, which switches every capability back on', async () => {
    await expect(constraintsFailed({ disabledCapabilities: [] })).resolves.toEqual({});
  });

  it('accepts a list of known capabilities', async () => {
    await expect(constraintsFailed({ disabledCapabilities: ['Search', 'ListLanguages'] })).resolves.toEqual({});
  });

  it('refuses a value that names no capability', async () => {
    await expect(constraintsFailed({ disabledCapabilities: ['Search', 'Nope'] })).resolves.toEqual({
      disabledCapabilities: ['isIn'],
    });
  });

  // IsOptional would let null through to the database, which refuses it for
  // a list column: a 500 in place of a 400.
  it('refuses null, which clears nothing', async () => {
    const failed = await constraintsFailed({ disabledCapabilities: null });

    expect(failed['disabledCapabilities']).toContain('isArray');
  });

  it('refuses a bare string in place of a list', async () => {
    const failed = await constraintsFailed({ disabledCapabilities: 'Search' });

    expect(failed['disabledCapabilities']).toContain('isArray');
  });
});
