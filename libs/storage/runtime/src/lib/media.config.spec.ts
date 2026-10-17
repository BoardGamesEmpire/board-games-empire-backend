import { withEnvironment } from '@bge/testing';
import { MissingEnvironmentError } from '@status/envirator';
import Joi from 'joi';
import { MEDIA_LOCAL_DISK_ROOT_DEFAULTS, mediaConfig, mediaConfigValidationSchema } from './media.config.js';

describe('mediaConfigValidationSchema — MEDIA_LOCAL_DISK_SENTINEL_FILE', () => {
  const schema = Joi.object(mediaConfigValidationSchema);
  const validate = (value: string) =>
    schema.validate({ MEDIA_LOCAL_DISK_SENTINEL_FILE: value }, { allowUnknown: true });

  it('defaults to .bge-storage-sentinel when unset', () => {
    const { value, error } = schema.validate({}, { allowUnknown: true });
    expect(error).toBeUndefined();
    expect(value.MEDIA_LOCAL_DISK_SENTINEL_FILE).toBe('.bge-storage-sentinel');
  });

  it('accepts a bare filename', () => {
    expect(validate('.bge-storage-sentinel').error).toBeUndefined();
  });

  // Path separators, traversal, empty, and self-references would let sentinel
  // mode probe the wrong path (or the root itself) and defeat the unmount guard.
  it.each(['', 'a/b', '../x', '/etc/passwd', 'a\\b', '.', '..'])('rejects %p', (value) => {
    expect(validate(value).error).toBeDefined();
  });
});

describe('MEDIA_LOCAL_DISK_ROOT_DEFAULTS', () => {
  // MEDIA_LOCAL_DISK_ROOT has no plain `defaultValue`, so an environment
  // missing from this map has no fallback and the app fails to boot.
  it.each(['production', 'development', 'test'])('covers NODE_ENV=%s', (environment) => {
    expect(MEDIA_LOCAL_DISK_ROOT_DEFAULTS[environment]).toBeTruthy();
  });

  it('leaves staging to configure real storage explicitly', () => {
    expect(MEDIA_LOCAL_DISK_ROOT_DEFAULTS['staging']).toBeUndefined();
  });
});

describe('media config — MEDIA_LOCAL_DISK_ROOT', () => {
  const original = {
    NODE_ENV: process.env['NODE_ENV'],
    MEDIA_LOCAL_DISK_ROOT: process.env['MEDIA_LOCAL_DISK_ROOT'],
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('refuses to start staging without an explicit root', () => {
    process.env['NODE_ENV'] = 'staging';
    delete process.env['MEDIA_LOCAL_DISK_ROOT'];

    let thrown: unknown;
    try {
      mediaConfig();
    } catch (error) {
      thrown = error;
    }

    // Every other media key has a default, so the root is the only one named.
    expect(thrown).toBeInstanceOf(MissingEnvironmentError);
    expect(thrown).toMatchObject({ keys: ['MEDIA_LOCAL_DISK_ROOT'] });
  });
});

describe('media config — MEDIA_BASE_URL', () => {
  // The api's default port and its route prefix, so a development api's
  // signed links resolve with nothing set (#625).
  it("defaults to a development api's address", () => {
    expect(withEnvironment({ NODE_ENV: 'development' }, mediaConfig).baseUrl).toBe('http://localhost:33333/api');
  });

  // A schema's default is written into the environment and beats the config's.
  it('leaves MEDIA_BASE_URL unset in the schema, for the config to default', () => {
    const { value } = Joi.object(mediaConfigValidationSchema).validate({}, { allowUnknown: true });

    expect(value).not.toHaveProperty('MEDIA_BASE_URL');
  });
});

describe('mediaConfigValidationSchema — an empty value', () => {
  // `@bge/env` reads an empty variable as unset, so the config defaults it, or
  // refuses to start where it has no default.
  it.each(['MEDIA_LOCAL_DISK_ROOT', 'MEDIA_BASE_URL'])(
    'accepts an empty %s, for the config to read as unset',
    (variable) => {
      const { error } = Joi.object(mediaConfigValidationSchema).validate({ [variable]: '' }, { allowUnknown: true });

      expect(error).toBeUndefined();
    },
  );
});
