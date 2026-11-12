import { ArgumentsHost, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { MulterError } from 'multer';
import { MAX_UPLOAD_BYTES } from './media-mime.policy';
import { MulterExceptionFilter } from './multer-exception.filter';

describe('MulterExceptionFilter', () => {
  let filter: MulterExceptionFilter;
  let superCatch: jest.SpyInstance;
  let translate: jest.Mock;
  const host = {} as ArgumentsHost;

  beforeEach(() => {
    // Echo the key back so the assertions name the catalog entry, never Multer's English.
    translate = jest.fn((key: string) => `t:${key}`);
    filter = new MulterExceptionFilter({ translate } as never, { getLocale: () => 'en' } as never);
    superCatch = jest.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const rendered = (): HttpException => superCatch.mock.calls[0][0] as HttpException;

  it('answers a file over the limit with 413 in the error envelope, naming the limit (#1260, #325)', () => {
    const tooLarge = new MulterError('LIMIT_FILE_SIZE', 'file');

    filter.catch(tooLarge, host);

    expect(rendered().getStatus()).toBe(413);
    expect(rendered().getResponse()).toEqual({
      statusCode: 413,
      error: 'Payload Too Large',
      message: 't:errors.upload.too_large',
    });
    expect(translate).toHaveBeenCalledWith('errors.upload.too_large', {
      lang: 'en',
      args: { maxBytes: MAX_UPLOAD_BYTES },
    });
  });

  it("answers any other Multer refusal with 400 in the error envelope, never Multer's own text (#1260, #325)", () => {
    filter.catch(new MulterError('LIMIT_UNEXPECTED_FILE', 'avatar'), host);

    expect(rendered().getStatus()).toBe(400);
    expect(rendered().getResponse()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 't:errors.upload.invalid',
    });
  });
});
