import { ArgumentsHost, HttpException, NotFoundException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { I18nExceptionFilter } from './i18n-exception.filter';
import { t } from './translatable';

describe('I18nExceptionFilter', () => {
  let filter: I18nExceptionFilter;
  let translate: jest.Mock;
  let getLocale: jest.Mock;
  let superCatch: jest.SpyInstance;

  const httpHost = { getType: () => 'http' } as unknown as ArgumentsHost;

  beforeEach(() => {
    translate = jest.fn().mockReturnValue('translated message');
    getLocale = jest.fn().mockReturnValue('en');
    filter = new I18nExceptionFilter({ translate } as never, { getLocale } as never);
    // super.catch renders via the HTTP adapter (absent in a unit test); stub it
    // and assert on what the filter hands off instead.
    superCatch = jest.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('translates an i18n-carrying exception and re-issues the standard body/status', () => {
    filter.catch(new NotFoundException(t('errors.language.not_found', { id: '42' })), httpHost);

    expect(translate).toHaveBeenCalledWith('errors.language.not_found', { lang: 'en', args: { id: '42' } });
    expect(superCatch).toHaveBeenCalledTimes(1);

    const [rebuilt] = superCatch.mock.calls[0] as [HttpException, ArgumentsHost];
    expect(rebuilt).toBeInstanceOf(HttpException);
    expect(rebuilt.getStatus()).toBe(404);
    expect(rebuilt.getResponse()).toEqual({
      statusCode: 404,
      message: 'translated message',
      error: 'Not Found',
    });
  });

  it('falls back to the default locale when none is resolved', () => {
    getLocale.mockReturnValue(null);

    filter.catch(new NotFoundException(t('errors.language.not_found', { id: '1' })), httpHost);

    expect(translate).toHaveBeenCalledWith('errors.language.not_found', { lang: 'en', args: { id: '1' } });
  });

  it('degrades to the default locale when the CLS read throws', () => {
    getLocale.mockImplementation(() => {
      throw new Error('no active CLS scope');
    });

    filter.catch(new NotFoundException(t('errors.language.not_found', { id: '1' })), httpHost);

    expect(translate).toHaveBeenCalledWith('errors.language.not_found', expect.objectContaining({ lang: 'en' }));
  });

  it('delegates a non-i18n HttpException to the base filter unchanged', () => {
    const exception = new NotFoundException('plain english message');

    filter.catch(exception, httpHost);

    expect(translate).not.toHaveBeenCalled();
    expect(superCatch).toHaveBeenCalledWith(exception, httpHost);
  });

  it('delegates non-HTTP transports to the base filter (WS is handled elsewhere)', () => {
    const wsHost = { getType: () => 'ws' } as unknown as ArgumentsHost;
    const exception = new NotFoundException(t('errors.language.not_found', { id: '1' }));

    filter.catch(exception, wsHost);

    expect(translate).not.toHaveBeenCalled();
    expect(superCatch).toHaveBeenCalledWith(exception, wsHost);
  });
});
