import {
  DriverNotRegisteredError,
  InsufficientStorageError,
  ObjectNotFoundError,
  SignatureExpiredError,
  SignatureInvalidError,
  StorageError,
  StorageUnavailableError,
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

  it('StorageUnavailableError carries retryable, code, name, and cause', () => {
    const cause = new Error('EIO');
    const err = new StorageUnavailableError('volume gone', { retryable: true, cause });
    expect(err).toBeInstanceOf(StorageError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('STORAGE_UNAVAILABLE');
    expect(err.retryable).toBe(true);
    expect(err.name).toBe('StorageUnavailableError');
    expect(err.cause).toBe(cause);
  });

  it('StorageUnavailableError can be non-retryable', () => {
    expect(new StorageUnavailableError('denied', { retryable: false }).retryable).toBe(false);
  });

  it('InsufficientStorageError carries code, name, and cause', () => {
    const cause = new Error('ENOSPC');
    const err = new InsufficientStorageError('disk full', { cause });
    expect(err).toBeInstanceOf(StorageError);
    expect(err.code).toBe('INSUFFICIENT_STORAGE');
    expect(err.name).toBe('InsufficientStorageError');
    expect(err.cause).toBe(cause);
  });
});
