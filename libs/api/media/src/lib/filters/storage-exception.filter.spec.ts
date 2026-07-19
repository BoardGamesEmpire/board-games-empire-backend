import {
  DriverNotRegisteredError,
  InsufficientStorageError,
  StorageMisconfiguredError,
  StorageUnavailableError,
} from '@boardgamesempire/storage-contract';
import { ArgumentsHost, HttpException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Http } from '@status/codes';
import { StorageExceptionFilter } from './storage-exception.filter';

describe('StorageExceptionFilter', () => {
  let filter: StorageExceptionFilter;
  let superCatch: jest.SpyInstance;
  let setHeader: jest.Mock;
  let translate: jest.Mock;
  let host: ArgumentsHost;

  beforeEach(() => {
    // Echo the key back so tests can assert which catalog message was chosen —
    // never the raw storage-error message (that would leak internal keys).
    translate = jest.fn((key: string) => `t:${key}`);
    filter = new StorageExceptionFilter({ translate } as never, { getLocale: () => 'en' } as never);
    superCatch = jest.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    setHeader = jest.fn();
    (filter as unknown as { httpAdapterHost: { httpAdapter: { setHeader: jest.Mock } } }).httpAdapterHost = {
      httpAdapter: { setHeader },
    };
    host = { switchToHttp: () => ({ getResponse: () => ({}) }) } as unknown as ArgumentsHost;
  });

  afterEach(() => jest.restoreAllMocks());

  // The filter re-issues a standard HttpException after translating the marker,
  // so we assert the resolved status/body handed to the base filter.
  const rendered = (): HttpException => superCatch.mock.calls[0][0] as HttpException;
  const message = (): unknown => (rendered().getResponse() as { message: unknown }).message;

  it('maps InsufficientStorageError to 507 with a generic localized message, no Retry-After', () => {
    filter.catch(new InsufficientStorageError('bucket users/42 is full'), host);

    expect(rendered().getStatus()).toBe(Http.InsufficientStorage);
    // The raw storage message ("bucket users/42 is full") is never surfaced.
    expect(translate).toHaveBeenCalledWith('errors.storage.insufficient', expect.objectContaining({ lang: 'en' }));
    expect(message()).toBe('t:errors.storage.insufficient');
    // ...but the raw error is retained as `cause` for server-side logs (the
    // translated re-issue must not strip it).
    expect((rendered() as unknown as { cause?: unknown }).cause).toBeInstanceOf(InsufficientStorageError);
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('maps a retryable StorageUnavailableError to 503 + Retry-After', () => {
    filter.catch(new StorageUnavailableError('io', { retryable: true }), host);

    expect(rendered().getStatus()).toBe(Http.ServiceUnavailable);
    expect(translate).toHaveBeenCalledWith('errors.storage.unavailable', expect.objectContaining({ lang: 'en' }));
    expect((rendered() as unknown as { cause?: unknown }).cause).toBeInstanceOf(StorageUnavailableError);
    expect(setHeader).toHaveBeenCalledWith({}, 'Retry-After', '30');
  });

  it('maps a non-retryable StorageUnavailableError to 503 without Retry-After', () => {
    filter.catch(new StorageUnavailableError('denied', { retryable: false }), host);

    expect(rendered().getStatus()).toBe(Http.ServiceUnavailable);
    expect(setHeader).not.toHaveBeenCalled();
  });

  it.each([new StorageMisconfiguredError('bad config'), new DriverNotRegisteredError('s3')])(
    'maps %s to 503 and logs critical',
    (exception) => {
      filter.catch(exception, host);

      expect(rendered().getStatus()).toBe(Http.ServiceUnavailable);
      expect(message()).toBe('t:errors.storage.unavailable');
      expect(Logger.prototype.error).toHaveBeenCalled();
    },
  );
});
