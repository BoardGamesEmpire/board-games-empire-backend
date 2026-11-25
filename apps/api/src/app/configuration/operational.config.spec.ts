import { withEnvironment } from '@bge/testing';
import Joi from 'joi';
import { DEFAULT_OPERATIONAL_SOURCES } from '../lib/operational-sources';
import { configurationValidationSchema } from './index';
import operationalConfig, { operationalConfigValidationSchema } from './operational.config';

const schema = Joi.object(operationalConfigValidationSchema);

/** Validates as `ConfigModule.forRoot` does, reporting every failure rather than the first. */
const validate = (variables: Record<string, string>) =>
  schema.validate(variables, { allowUnknown: true, abortEarly: false });

/** The whole root schema, which is where the two ports meet. */
const validateRoot = (variables: Record<string, string>) =>
  configurationValidationSchema.validate(variables, { allowUnknown: true, abortEarly: false });

const read = (variables: Record<string, string>) =>
  withEnvironment({ NODE_ENV: 'test', ...variables }, operationalConfig);

describe("the api's operational port config (#1511)", () => {
  it('listens on 33334 and allows the default sources when nothing is set', () => {
    expect(read({})).toEqual({ port: 33334, sources: DEFAULT_OPERATIONAL_SOURCES });
  });

  it('listens on OPERATIONAL_PORT', () => {
    expect(read({ OPERATIONAL_PORT: '40000' }).port).toBe(40000);
  });

  // Joi accepts exponent notation and the root schema's collision check reads
  // its converted value, so the listener must bind that same port (#1511).
  it.each([
    ['1e3', 1000],
    ['40000e-1', 4000],
  ])('reads an OPERATIONAL_PORT of %p as Joi converts it, %p', (value, port) => {
    expect(validate({ OPERATIONAL_PORT: value }).value.OPERATIONAL_PORT).toBe(port);
    expect(read({ OPERATIONAL_PORT: value }).port).toBe(port);
  });

  it('reads OPERATIONAL_SOURCES as a trimmed list that replaces the defaults', () => {
    expect(read({ OPERATIONAL_SOURCES: '10.0.0.0/8, 203.0.113.0/24' }).sources).toEqual([
      '10.0.0.0/8',
      '203.0.113.0/24',
    ]);
  });

  // `@bge/env` reads an empty variable as unset, so the config defaults it.
  it.each(['OPERATIONAL_PORT', 'OPERATIONAL_SOURCES'])(
    'accepts an empty %s, for the config to read as unset',
    (name) => {
      expect(validate({ [name]: '' }).error).toBeUndefined();
      expect(read({ [name]: '' })).toEqual({ port: 33334, sources: DEFAULT_OPERATIONAL_SOURCES });
    },
  );

  // The config owns the defaults: a Joi default would be written into the
  // environment ahead of it (#626).
  it('leaves both variables unset, for the config to default', () => {
    expect(validate({}).value).not.toHaveProperty('OPERATIONAL_PORT');
    expect(validate({}).value).not.toHaveProperty('OPERATIONAL_SOURCES');
  });

  it('rejects an OPERATIONAL_PORT that is no port', () => {
    expect(validate({ OPERATIONAL_PORT: '99999' }).error?.message).toMatch(/OPERATIONAL_PORT/);
  });

  // `parseCidrList` drops an entry it can't read, which would narrow the rule
  // without telling the operator, so boot refuses it instead.
  // `/8x` and `/2 4` must not pass as /8 and /2 and widen the range;
  // `parseCidr` refuses a prefix that isn't a plain decimal number (#1519).
  it.each([
    '10.0.0.0/33',
    '10.0.0.5',
    'garbage',
    '10.0.0.0/8,',
    '10.0.0.0/8, ,192.168.0.0/16',
    'fc00::/129',
    '10.0.0.0/8x',
    '10.0.0.0/2 4',
  ])('rejects an OPERATIONAL_SOURCES of %p, naming the variable', (sources) => {
    expect(validate({ OPERATIONAL_SOURCES: sources }).error?.message).toMatch(/OPERATIONAL_SOURCES/);
  });

  it('accepts an OPERATIONAL_SOURCES of IPv4 and IPv6 ranges', () => {
    expect(validate({ OPERATIONAL_SOURCES: '10.0.0.0/8, fd00::/8' }).error).toBeUndefined();
  });

  describe('the root schema', () => {
    // Two listeners on one port would fail at listen with EADDRINUSE, after
    // the rest of boot; the operator needs the variable's name instead.
    it('refuses an OPERATIONAL_PORT equal to PORT, naming OPERATIONAL_PORT', () => {
      expect(validateRoot({ PORT: '40000', OPERATIONAL_PORT: '40000' }).error?.message).toMatch(/OPERATIONAL_PORT/);
    });

    it('refuses a PORT of 33334 when OPERATIONAL_PORT is unset, which defaults to it', () => {
      expect(validateRoot({ PORT: '33334' }).error?.message).toMatch(/OPERATIONAL_PORT/);
    });

    it('refuses an OPERATIONAL_PORT of 33333 when PORT is unset, which defaults to it', () => {
      expect(validateRoot({ OPERATIONAL_PORT: '33333' }).error?.message).toMatch(/OPERATIONAL_PORT/);
    });

    it('reads an empty PORT as its default when comparing', () => {
      expect(validateRoot({ PORT: '', OPERATIONAL_PORT: '33333' }).error?.message).toMatch(/OPERATIONAL_PORT/);
    });

    // `Number(x) || default` would read a PORT of 0 as unset and refuse this (#1511).
    it('reads a PORT of 0 as a port, not as unset', () => {
      expect(validateRoot({ PORT: '0', OPERATIONAL_PORT: '33333' }).error).toBeUndefined();
    });

    it('accepts the two defaults, and two ports that differ', () => {
      expect(validateRoot({}).error).toBeUndefined();
      expect(validateRoot({ PORT: '8080', OPERATIONAL_PORT: '8081' }).error).toBeUndefined();
    });
  });
});
