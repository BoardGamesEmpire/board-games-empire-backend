import {
  DriverNotRegisteredError,
  ObjectNotFoundError,
  SignatureExpiredError,
  SignatureInvalidError,
  StorageError,
} from './errors.js';

describe('storage errors', () => {
  it('ObjectNotFoundError carries key, code, and message', () => {
    const err = new ObjectNotFoundError('media/abc');
    expect(err).toBeInstanceOf(StorageError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('OBJECT_NOT_FOUND');
    expect(err.key).toBe('media/abc');
    expect(err.name).toBe('ObjectNotFoundError');
    expect(err.message).toContain('media/abc');
  });

  it('signature errors expose stable codes', () => {
    expect(new SignatureInvalidError().code).toBe('SIGNATURE_INVALID');
    expect(new SignatureExpiredError().code).toBe('SIGNATURE_EXPIRED');
  });

  it('preserves the error cause', () => {
    const cause = new Error('disk gone');
    expect(new ObjectNotFoundError('k', { cause }).cause).toBe(cause);
  });

  it('DriverNotRegisteredError carries slug, code, and message', () => {
    const err = new DriverNotRegisteredError('s3');
    expect(err).toBeInstanceOf(StorageError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('DRIVER_NOT_REGISTERED');
    expect(err.slug).toBe('s3');
    expect(err.name).toBe('DriverNotRegisteredError');
    expect(err.message).toContain('s3');
  });

  it('DriverNotRegisteredError preserves the error cause', () => {
    const cause = new Error('config drift');
    expect(new DriverNotRegisteredError('s3', { cause }).cause).toBe(cause);
  });
});
