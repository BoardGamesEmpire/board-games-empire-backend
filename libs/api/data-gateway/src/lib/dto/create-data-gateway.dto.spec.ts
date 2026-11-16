import { AuthType } from '@bge/database';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateDataGatewayDto } from './create-data-gateway.dto';

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function constraintsFailed(payload: Record<string, unknown>): Promise<Record<string, string[]>> {
  const dto = plainToInstance(CreateDataGatewayDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return Object.fromEntries(errors.map((error) => [error.property, Object.keys(error.constraints ?? {})]));
}

const REMOTE = { name: 'BGG', connectionUrl: 'localhost', connectionPort: 50051, authType: AuthType.None };

// The route creates remote DataGateways only. A plugin DataGateway's row comes
// from installing its plugin (#1083).
describe('CreateDataGatewayDto', () => {
  it('accepts a remote DataGateway with its three connection fields (#1083)', async () => {
    await expect(constraintsFailed(REMOTE)).resolves.toEqual({});
  });

  it.each(['connectionUrl', 'connectionPort', 'authType'] as const)(
    'still requires %s, which a remote DataGateway is reached through (#1083)',
    async (field) => {
      const body: Record<string, unknown> = { ...REMOTE };
      delete body[field];

      const failed = await constraintsFailed(body);

      expect(Object.keys(failed)).toEqual([field]);
    },
  );

  it.each(['connectionUrl', 'connectionPort', 'authType'] as const)('refuses null for %s (#1083)', async (field) => {
    const failed = await constraintsFailed({ ...REMOTE, [field]: null });

    expect(Object.keys(failed)).toEqual([field]);
  });

  // The service spreads the body into the row it creates, so this refusal is
  // what keeps a client from making a plugin DataGateway's row (#1083).
  it('refuses a pluginId (#1083)', async () => {
    await expect(constraintsFailed({ ...REMOTE, pluginId: 'plugin-1' })).resolves.toEqual({
      pluginId: ['whitelistValidation'],
    });
  });
});
