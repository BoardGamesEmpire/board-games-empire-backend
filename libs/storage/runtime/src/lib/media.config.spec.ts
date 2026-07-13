import Joi from 'joi';
import { mediaConfigValidationSchema } from './media.config.js';

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
