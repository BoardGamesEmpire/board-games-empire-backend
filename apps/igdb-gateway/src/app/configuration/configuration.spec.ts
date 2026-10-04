import { configurationValidationSchema } from './index';

/**
 * Validates as `ConfigModule.forRoot` does: a key the schema does not name
 * passes through untouched. So a rule in a schema that never reaches the
 * root never fails; it never runs at all.
 */
const validate = (environment: Record<string, string>) =>
  configurationValidationSchema.validate(environment, { allowUnknown: true });

const BOOTABLE = {
  IGDB_CLIENT_ID: 'test-client-id',
  IGDB_CLIENT_SECRET: 'test-client-secret',
  IGDB_GATEWAY_GRPC_HOST: 'localhost',
  IGDB_GATEWAY_GRPC_PORT: '50054',
};

describe('the IGDB gateway configuration schema', () => {
  it('accepts the credentials and gRPC address the gateway boots with', () => {
    expect(validate(BOOTABLE).error).toBeUndefined();
  });

  it.each(['IGDB_CLIENT_ID', 'IGDB_CLIENT_SECRET'] as const)('requires %s', (key) => {
    const environment: Record<string, string> = { ...BOOTABLE };
    delete environment[key];

    expect(validate(environment).error?.message).toMatch(key);
  });

  it('adds no gRPC address of its own when the environment sets none', () => {
    // ConfigModule copies each validated value into process.env when the
    // variable is unset, so a default here would override the gateway
    // config's per-environment ones (production binds 50051).
    const credentials = { IGDB_CLIENT_ID: 'test-client-id', IGDB_CLIENT_SECRET: 'test-client-secret' };

    expect(validate(credentials).value).toEqual(credentials);
  });
});
