import gatewayConfig from './gateway.config';
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

  it.each(['99999', '1e5', '50051.9'])('rejects a gRPC port of %s, which is no port', (port) => {
    const { error } = validate({ ...BOOTABLE, IGDB_GATEWAY_GRPC_PORT: port });

    expect(error?.message).toMatch(/IGDB_GATEWAY_GRPC_PORT/);
  });

  it.each(['0.0.0.0', '::', 'igdb-gateway'])('accepts a gRPC host of %s', (host) => {
    expect(validate({ ...BOOTABLE, IGDB_GATEWAY_GRPC_HOST: host }).error).toBeUndefined();
  });

  // A CIDR range names many addresses, and the gateway listens on one.
  it.each(['not a host', '10.0.0.0/8'])('rejects a gRPC host of %s, which is no host', (host) => {
    const { error } = validate({ ...BOOTABLE, IGDB_GATEWAY_GRPC_HOST: host });

    expect(error?.message).toMatch(/IGDB_GATEWAY_GRPC_HOST/);
  });

  // `@bge/env` reads an empty variable as unset, so the config defaults it.
  it('accepts an empty gRPC address, for the config to default', () => {
    const { error } = validate({ ...BOOTABLE, IGDB_GATEWAY_GRPC_HOST: '', IGDB_GATEWAY_GRPC_PORT: '' });

    expect(error).toBeUndefined();
  });

  // ConfigModule copies a schema's default into an unset variable, where it
  // beats the config's own default (#626).
  it('leaves an unset gRPC address unset, for the config to default', () => {
    const { value } = validate({
      IGDB_CLIENT_ID: 'test-client-id',
      IGDB_CLIENT_SECRET: 'test-client-secret',
      NODE_ENV: 'production',
    });

    expect(value).not.toHaveProperty('IGDB_GATEWAY_GRPC_HOST');
    expect(value).not.toHaveProperty('IGDB_GATEWAY_GRPC_PORT');
  });
});

/** The config the gateway's bootstrap reads the address it listens on from. */
describe('the IGDB gateway configuration', () => {
  const original = process.env;

  beforeEach(() => {
    process.env = { ...original };
    delete process.env['IGDB_GATEWAY_GRPC_HOST'];
    delete process.env['IGDB_GATEWAY_GRPC_PORT'];
    delete process.env['NODE_ENV'];
  });

  afterEach(() => {
    process.env = original;
  });

  it.each([
    [undefined, 50054],
    ['development', 50054],
    ['test', 50054],
    ['production', 50051],
  ])('defaults the gRPC address for NODE_ENV %s to 0.0.0.0:%i', (nodeEnv, port) => {
    if (nodeEnv) {
      process.env['NODE_ENV'] = nodeEnv;
    }

    expect(gatewayConfig()).toEqual({ host: '0.0.0.0', port });
  });

  it('keeps the gRPC address the environment sets, in production too', () => {
    Object.assign(process.env, BOOTABLE, { NODE_ENV: 'production' });

    expect(gatewayConfig()).toEqual({ host: 'localhost', port: 50054 });
  });

  it('defaults an empty gRPC address as it does an unset one', () => {
    Object.assign(process.env, { IGDB_GATEWAY_GRPC_HOST: '', IGDB_GATEWAY_GRPC_PORT: '', NODE_ENV: 'production' });

    expect(gatewayConfig()).toEqual({ host: '0.0.0.0', port: 50051 });
  });

  // The schema reads `5e4` as 50000. Read any other way, the gateway would
  // listen on a port the schema never checked.
  it('reads a gRPC port in exponent form as the schema does', () => {
    Object.assign(process.env, BOOTABLE, { IGDB_GATEWAY_GRPC_PORT: '5e4' });

    expect(gatewayConfig().port).toBe(50000);
  });
});
