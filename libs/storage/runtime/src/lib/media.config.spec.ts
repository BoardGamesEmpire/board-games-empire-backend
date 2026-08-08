import Joi from 'joi';
import { MEDIA_LOCAL_DISK_ROOT_DEFAULTS, mediaConfigValidationSchema } from './media.config.js';

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
  // missing from this map has no fallback and @bge/env exits the process at
  // boot. `testing` was absent until #259 because nothing set NODE_ENV=testing
  // until the e2e harness pinned it.
  it.each(['production', 'development', 'testing'])('covers NODE_ENV=%s', (environment) => {
    expect(MEDIA_LOCAL_DISK_ROOT_DEFAULTS[environment]).toBeTruthy();
  });

  it('leaves staging to configure real storage explicitly', () => {
    expect(MEDIA_LOCAL_DISK_ROOT_DEFAULTS['staging']).toBeUndefined();
  });
});
