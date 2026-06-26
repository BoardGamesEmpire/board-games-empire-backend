/**
 * Base class for all storage-layer errors. Carries a stable `code` for mapping at the edge.
 */
export abstract class StorageError extends Error {
  abstract readonly code: string;

  protected constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ObjectNotFoundError extends StorageError {
  readonly code = 'OBJECT_NOT_FOUND';

  constructor(
    readonly key: string,
    options?: { cause?: unknown },
  ) {
    super(`No stored object for key '${key}'`, options);
  }
}

export class InvalidObjectKeyError extends StorageError {
  readonly code = 'INVALID_OBJECT_KEY';

  constructor(
    readonly key: string,
    options?: { cause?: unknown },
  ) {
    super(`Object key '${key}' is invalid or escapes the storage root`, options);
  }
}

export class SignatureInvalidError extends StorageError {
  readonly code = 'SIGNATURE_INVALID';

  constructor(message = 'Signed URL signature is invalid', options?: { cause?: unknown }) {
    super(message, options);
  }
}

export class SignatureExpiredError extends StorageError {
  readonly code = 'SIGNATURE_EXPIRED';

  constructor(message = 'Signed URL has expired', options?: { cause?: unknown }) {
    super(message, options);
  }
}

export class StorageMisconfiguredError extends StorageError {
  readonly code = 'STORAGE_MISCONFIGURED';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
