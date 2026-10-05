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

  // ConfigModule copies these defaults into process.env, where the bootstrap
  // reads the address the gateway listens on.
  it.each([
    [undefined, 50054],
    ['development', 50054],
    ['test', 50054],
    ['production', 50051],
  ])('defaults the gRPC address for NODE_ENV %s to 0.0.0.0:%i', (nodeEnv, port) => {
    const credentials = { IGDB_CLIENT_ID: 'test-client-id', IGDB_CLIENT_SECRET: 'test-client-secret' };
    const { value } = validate(nodeEnv ? { ...credentials, NODE_ENV: nodeEnv } : credentials);

    expect(value).toMatchObject({ IGDB_GATEWAY_GRPC_HOST: '0.0.0.0', IGDB_GATEWAY_GRPC_PORT: port });
  });

  it('keeps the gRPC address the environment sets, in production too', () => {
    const { value } = validate({ ...BOOTABLE, NODE_ENV: 'production' });

    expect(value).toMatchObject({ IGDB_GATEWAY_GRPC_HOST: 'localhost', IGDB_GATEWAY_GRPC_PORT: 50054 });
  });
});
