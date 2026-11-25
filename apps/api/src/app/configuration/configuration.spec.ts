import { authConfigValidationSchema } from '@bge/auth';
import { healthConfigValidationSchema } from '@bge/health';
import { prometheusConfigValidationSchema } from '@bge/metrics';
import { securityTxtConfigValidationSchema } from '@bge/well-known';
import { configurationValidationSchema } from './index';
import { swaggerConfigValidationSchema } from './swagger.config';

/** Validates as `ConfigModule.forRoot` does, reporting every failure rather than the first. */
const validate = (environment: Record<string, string>) =>
  configurationValidationSchema.validate(environment, { allowUnknown: true, abortEarly: false });

/** The variables of auth, health, security.txt and Prometheus, which load their configs with `forFeature`. */
const featureVariables = Object.keys({
  ...authConfigValidationSchema,
  ...healthConfigValidationSchema,
  ...securityTxtConfigValidationSchema,
  ...prometheusConfigValidationSchema,
});

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

  // Auth, security.txt and Prometheus load their configs with
  // `forFeature` too.
  it.each([
    ['BETTER_AUTH_SECRET', 'short'],
    ['BETTER_AUTH_URL', 'not a url'],
    ['SECURITY_POLICY_URL', 'not a url'],
    ['PROMETHEUS_DEFAULT_METRICS_TIMEOUT', 'soon'],
    ['PROMETHEUS_DEFAULT_METRICS_ENABLED', 'sometimes'],
  ])('rejects a malformed %s', (variable, value) => {
    const { error } = validate({ [variable]: value });

    expect(error?.details.map(({ path }) => path.join('.'))).toContain(variable);
  });

  // Auth's config defaults both outside production and staging, and requires
  // them there. A schema that required them would stop a development boot
  // that has no `.env`.
  it("accepts no auth secret or URL, for auth's config to default or require", () => {
    const { error } = validate({});
    const failed = error?.details.map(({ path }) => path.join('.')) ?? [];

    expect(failed).not.toContain('BETTER_AUTH_SECRET');
    expect(failed).not.toContain('BETTER_AUTH_URL');
  });

  // A schema's default is written into the environment and beats the config's.
  it('leaves their variables unset, for their configs to default', () => {
    const { value } = validate({});

    expect(featureVariables.filter((variable) => variable in value)).toEqual([]);
  });

  // `@bge/env` reads an empty variable as unset, so the config defaults it, or
  // refuses to start where it has no default.
  it.each(featureVariables)('accepts an empty %s, for its config to read as unset', (variable) => {
    const { error } = validate({ [variable]: '' });

    expect(error?.details.map(({ path }) => path.join('.')) ?? []).not.toContain(variable);
  });
});

describe("the API document's variables (#1511)", () => {
  const documentVariables = Object.keys(swaggerConfigValidationSchema);

  // A schema default is written into the environment and beats the config's
  // (#626): SWAGGER_VERSION's '1.0' beat the config's '1.0.0'.
  it('leaves them unset, for their config to default', () => {
    const { value } = validate({});

    expect(documentVariables.filter((variable) => variable in value)).toEqual([]);
  });

  it.each(documentVariables)('accepts an empty %s, for its config to read as unset', (variable) => {
    const { error } = validate({ [variable]: '' });

    expect(error?.details.map(({ path }) => path.join('.')) ?? []).not.toContain(variable);
  });

  // The API document is always served, on the operational port.
  it('has no switch to turn the API document off', () => {
    expect(documentVariables).toEqual(['SWAGGER_TITLE', 'SWAGGER_DESCRIPTION', 'SWAGGER_VERSION']);
  });
});

describe("the api's sign-in provider variables", () => {
  // The schema can't tell a listed provider's variable from an unlisted one,
  // so it leaves them all to auth's config, which checks the listed ones. An
  // unlisted provider's variable only warns, so it must not stop the api here
  // (#912).
  it("lets an unlisted provider's malformed discovery URL through (#912)", () => {
    const { error } = validate({ OIDC_OLD_DISCOVERY_URL: 'not a url' });

    expect(error?.details.map(({ path }) => path.join('.')) ?? []).not.toContain('OIDC_OLD_DISCOVERY_URL');
  });
});

describe("the api's two ports", () => {
  // Two listeners on one port would fail at listen, after the rest of boot (#1511).
  it('refuses an OPERATIONAL_PORT equal to PORT', () => {
    expect(validate({ PORT: '40000', OPERATIONAL_PORT: '40000' }).error?.message).toMatch(
      /OPERATIONAL_PORT must differ from PORT/,
    );
  });

  // Port 0 asks the OS for a free port, a different one for each listener (#1511).
  it('lets PORT and OPERATIONAL_PORT both be 0', () => {
    expect(validate({ PORT: '0', OPERATIONAL_PORT: '0' }).error).toBeUndefined();
  });
});
