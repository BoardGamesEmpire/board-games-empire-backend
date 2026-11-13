/* eslint-disable bge/no-uncoded-exception-body -- these cases hand the renderer a coded body no producer may build, to pin that it completes any body into the envelope (#1260) */
import { t } from '@bge/i18n-core';
import { ArgumentsHost, ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { I18nExceptionFilter } from './i18n-exception.filter';

describe('I18nExceptionFilter', () => {
  let filter: I18nExceptionFilter;
  let translate: jest.Mock;
  let getLocale: jest.Mock;
  let resolveAcceptLanguage: jest.Mock;
  let superCatch: jest.SpyInstance;

  // A request a route matched, as every request a handler throws from is.
  const httpHost = {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => ({ route: { path: '/languages/:id' }, headers: { 'accept-language': 'de' } }),
    }),
  } as unknown as ArgumentsHost;

  beforeEach(() => {
    translate = jest.fn().mockReturnValue('translated message');
    getLocale = jest.fn().mockReturnValue('en');
    resolveAcceptLanguage = jest.fn().mockReturnValue('de');
    filter = new I18nExceptionFilter(
      { translate } as never,
      { getLocale } as never,
      {
        resolveAcceptLanguage,
      } as never,
    );
    // super.catch renders via the HTTP adapter (absent in a unit test); stub it
    // and assert on what the filter hands off instead.
    superCatch = jest.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('translates an i18n-carrying exception and re-issues the standard body/status', () => {
    filter.catch(new NotFoundException(t('errors.language.not_found', { id: '42' })), httpHost);

    expect(translate).toHaveBeenCalledWith('errors.language.not_found', { lang: 'en', args: { id: '42' } });
    // The CLS locale wins: the header is read only when CLS holds none.
    expect(resolveAcceptLanguage).not.toHaveBeenCalled();
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

  // An error raised before the locale middleware ran, such as body-parser's,
  // has no CLS locale yet (#527).
  it("renders in the request's Accept-Language locale when CLS holds none (#527)", () => {
    getLocale.mockReturnValue(null);

    filter.catch(new NotFoundException(t('errors.language.not_found', { id: '1' })), httpHost);

    expect(resolveAcceptLanguage).toHaveBeenCalledWith('de');
    expect(translate).toHaveBeenCalledWith('errors.language.not_found', { lang: 'de', args: { id: '1' } });
  });

  it("renders in the request's Accept-Language locale when the CLS read throws (#527)", () => {
    getLocale.mockImplementation(() => {
      throw new Error('no active CLS scope');
    });

    filter.catch(new NotFoundException(t('errors.language.not_found', { id: '1' })), httpHost);

    expect(translate).toHaveBeenCalledWith('errors.language.not_found', expect.objectContaining({ lang: 'de' }));
  });

  it('hands a non-i18n HttpException to the base filter as the envelope, untranslated (#1260)', () => {
    filter.catch(new ConflictException({ code: 'CATALOG_ENTRY_CHANGED', message: 'plain english message' }), httpHost);

    expect(translate).not.toHaveBeenCalled();
    const [rebuilt] = superCatch.mock.calls[0] as [HttpException, ArgumentsHost];
    expect(rebuilt.getStatus()).toBe(409);
    expect(rebuilt.getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: 'plain english message',
      code: 'CATALOG_ENTRY_CHANGED',
    });
  });

  it('delegates non-HTTP transports to the base filter (WS is handled elsewhere)', () => {
    const wsHost = { getType: () => 'ws' } as unknown as ArgumentsHost;
    const exception = new NotFoundException(t('errors.language.not_found', { id: '1' }));

    filter.catch(exception, wsHost);

    expect(translate).not.toHaveBeenCalled();
    expect(superCatch).toHaveBeenCalledWith(exception, wsHost);
  });
});
