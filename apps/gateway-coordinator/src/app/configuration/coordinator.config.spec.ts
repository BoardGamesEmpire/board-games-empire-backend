import { coordinatorClientConfig } from '@bge/coordinator';
import coordinatorConfig from './coordinator.config';
import { configurationValidationSchema } from './index';

const ADDRESS_VARIABLES = [
  'COORDINATOR_GRPC_HOST',
  'COORDINATOR_GRPC_PORT',
  'GATEWAY_COORDINATOR_HOST',
  'GATEWAY_COORDINATOR_PORT',
] as const;

describe("the coordinator's gRPC address", () => {
  const original = process.env;

  beforeEach(() => {
    process.env = { ...original };
    for (const variable of ADDRESS_VARIABLES) {
      delete process.env[variable];
    }
  });

  afterEach(() => {
    process.env = original;
  });

  // ConfigModule copies a schema's default into an unset variable, where it
  // beats the config's own default, the production one included (#626).
  it('is left unset by the schema, for the config to default', () => {
    const { error, value } = configurationValidationSchema.validate({ NODE_ENV: 'production' }, { allowUnknown: true });

    expect(error).toBeUndefined();
    expect(value).not.toHaveProperty('COORDINATOR_GRPC_HOST');
    expect(value).not.toHaveProperty('COORDINATOR_GRPC_PORT');
  });

  it.each([
    ['production', 50051],
    ['development', 50052],
  ])('defaults, under NODE_ENV %s, to the port the api dials: %i', (nodeEnv, port) => {
    process.env['NODE_ENV'] = nodeEnv;

    expect({ coordinator: coordinatorConfig().port, api: coordinatorClientConfig().port }).toEqual({
      coordinator: port,
      api: port,
    });
  });

  it.each(['99999', '1e5', '50051.9'])('is refused by the schema for a port of %s, which is no port', (port) => {
    const { error } = configurationValidationSchema.validate({ COORDINATOR_GRPC_PORT: port }, { allowUnknown: true });

    expect(error?.message).toMatch(/COORDINATOR_GRPC_PORT/);
  });

  it.each(['0.0.0.0', '::', 'gateway-coordinator'])('is accepted by the schema for a host of %s', (host) => {
    const { error } = configurationValidationSchema.validate({ COORDINATOR_GRPC_HOST: host }, { allowUnknown: true });

    expect(error).toBeUndefined();
  });

  // A CIDR range names many addresses, and the coordinator listens on one.
  it.each(['not a host', '10.0.0.0/8'])('is refused by the schema for a host of %s, which is no host', (host) => {
    const { error } = configurationValidationSchema.validate({ COORDINATOR_GRPC_HOST: host }, { allowUnknown: true });

    expect(error?.message).toMatch(/COORDINATOR_GRPC_HOST/);
  });

  // `@bge/env` reads an empty variable as unset, so the schema lets it through
  // and the config defaults it.
  it('is defaulted when set empty, as when unset', () => {
    const empty = { COORDINATOR_GRPC_HOST: '', COORDINATOR_GRPC_PORT: '' };
    const { error } = configurationValidationSchema.validate(empty, { allowUnknown: true });
    Object.assign(process.env, empty, { NODE_ENV: 'production' });

    expect(error).toBeUndefined();
    expect(coordinatorConfig()).toMatchObject({ host: '0.0.0.0', port: 50051 });
  });

  // The schema reads `5e4` as 50000. Read any other way, the coordinator
  // would listen on a port the schema never checked.
  it('reads a port in exponent form as the schema does', () => {
    process.env['COORDINATOR_GRPC_PORT'] = '5e4';

    expect(coordinatorConfig().port).toBe(50000);
  });
});
