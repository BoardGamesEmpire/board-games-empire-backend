import {
  DriverNotRegisteredError,
  InsufficientStorageError,
  StorageMisconfiguredError,
  StorageUnavailableError,
} from '@boardgamesempire/storage-contract';
import { ArgumentsHost, HttpException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Http } from '@status/codes';
import { InsufficientStorageException } from '../exceptions/insufficient-storage.exception';
import { StorageExceptionFilter } from './storage-exception.filter';

describe('StorageExceptionFilter', () => {
  let filter: StorageExceptionFilter;
  let superCatch: jest.SpyInstance;
  let setHeader: jest.Mock;
  let host: ArgumentsHost;

  beforeEach(() => {
    filter = new StorageExceptionFilter();
    superCatch = jest.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    setHeader = jest.fn();
    (filter as unknown as { httpAdapterHost: { httpAdapter: { setHeader: jest.Mock } } }).httpAdapterHost = {
      httpAdapter: { setHeader },
    };
    host = { switchToHttp: () => ({ getResponse: () => ({}) }) } as unknown as ArgumentsHost;
  });

  afterEach(() => jest.restoreAllMocks());

  const mapped = (): HttpException => superCatch.mock.calls[0][0] as HttpException;

  it('maps InsufficientStorageError to 507 with no Retry-After', () => {
    filter.catch(new InsufficientStorageError('full'), host);
    expect(mapped()).toBeInstanceOf(InsufficientStorageException);
    expect(mapped().getStatus()).toBe(Http.InsufficientStorage);
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('maps a retryable StorageUnavailableError to 503 + Retry-After', () => {
    filter.catch(new StorageUnavailableError('io', { retryable: true }), host);
    expect(mapped()).toBeInstanceOf(ServiceUnavailableException);
    expect(mapped().getStatus()).toBe(Http.ServiceUnavailable);
    expect(setHeader).toHaveBeenCalledWith({}, 'Retry-After', '30');
  });

  it('maps a non-retryable StorageUnavailableError to 503 without Retry-After', () => {
    filter.catch(new StorageUnavailableError('denied', { retryable: false }), host);
    expect(mapped().getStatus()).toBe(Http.ServiceUnavailable);
    expect(setHeader).not.toHaveBeenCalled();
  });

  it.each([new StorageMisconfiguredError('bad config'), new DriverNotRegisteredError('s3')])(
    'maps %s to 503 and logs critical',
    (exception) => {
      filter.catch(exception, host);
      expect(mapped()).toBeInstanceOf(ServiceUnavailableException);
      expect(mapped().getStatus()).toBe(Http.ServiceUnavailable);
      expect(Logger.prototype.error).toHaveBeenCalled();
    },
  );
});
