import { configurationValidationSchema } from './index';

/** Validates as `ConfigModule.forRoot` does, reporting every failure rather than the first. */
const validate = (environment: Record<string, string>) =>
  configurationValidationSchema.validate(environment, { allowUnknown: true, abortEarly: false });

describe("the api's configuration schema", () => {
  // The coordinator client loads its config with `forFeature`, which
  // validates nothing, so its variables are checked here or not at all.
  it.each(['GATEWAY_COORDINATOR_PORT', 'GATEWAY_COORDINATOR_HOST'])('rejects a malformed %s', (variable) => {
    const { error } = validate({ [variable]: 'not a port or host' });

    expect(error?.details.map(({ path }) => path.join('.'))).toContain(variable);
  });

  it.each(['99999', '1e5', '50051.9'])('rejects a GATEWAY_COORDINATOR_PORT of %s, which is no port', (port) => {
    const { error } = validate({ GATEWAY_COORDINATOR_PORT: port });

    expect(error?.details.map(({ path }) => path.join('.'))).toContain('GATEWAY_COORDINATOR_PORT');
  });

  it.each(['localhost', '::1', 'gateway-coordinator'])('accepts a GATEWAY_COORDINATOR_HOST of %s', (host) => {
    const { error } = validate({ GATEWAY_COORDINATOR_HOST: host });
    const failed = error?.details.map(({ path }) => path.join('.')) ?? [];

    expect(failed).not.toContain('GATEWAY_COORDINATOR_HOST');
  });

  // A CIDR range names many addresses, and the api dials one.
  it('rejects a GATEWAY_COORDINATOR_HOST that is a CIDR range, which is no host', () => {
    const { error } = validate({ GATEWAY_COORDINATOR_HOST: '10.0.0.0/8' });

    expect(error?.details.map(({ path }) => path.join('.'))).toContain('GATEWAY_COORDINATOR_HOST');
  });

  // `@bge/env` reads an empty variable as unset, so the client's config
  // defaults it.
  it("accepts an empty coordinator address, for the client's config to default", () => {
    const { error } = validate({ GATEWAY_COORDINATOR_HOST: '', GATEWAY_COORDINATOR_PORT: '' });
    const failed = error?.details.map(({ path }) => path.join('.')) ?? [];

    expect(failed).not.toContain('GATEWAY_COORDINATOR_HOST');
    expect(failed).not.toContain('GATEWAY_COORDINATOR_PORT');
  });

  it("leaves the coordinator's address unset, for the client's config to default", () => {
    const { value } = validate({ NODE_ENV: 'production' });

    expect(value).not.toHaveProperty('GATEWAY_COORDINATOR_HOST');
    expect(value).not.toHaveProperty('GATEWAY_COORDINATOR_PORT');
  });
});
