import { AuditContextService } from '@bge/actor-context';
import { I18N_CATALOG_DIR, i18nValidationMessage, t } from '@bge/i18n-core';
import { Body, Controller, Get, Logger, NotFoundException, Param, Post, Res } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { IsString } from 'class-validator';
import type { Response } from 'express';
import { I18nModule, I18nService, I18nValidationExceptionFilter, I18nValidationPipe } from 'nestjs-i18n';
import { I18nExceptionFilter } from './i18n-exception.filter';
import { LocaleResolutionService } from './locale-resolution.service';
import { FALLBACK_LOCALE } from './locale.constants';
import type { SupportedLocalesService } from './supported-locales.service';
import { UnknownErrorFilter } from './unknown-error.filter';

/** The api's body limit, `MAX_REQUEST_BODY_BYTES` in `@bge/auth`. */
const BODY_LIMIT = 256 * 1024;

const FAILED_COPY =
  "Something went wrong on the server, so your request wasn't completed. Try again, and if it keeps happening, tell the server's admin";
const TOO_LARGE_COPY = 'This request was too large for the server to read, so nothing was changed';
const UNREADABLE_COPY = "The server couldn't read this request, so nothing was changed";

class NamedDto {
  @IsString({ message: i18nValidationMessage('validation.isString') })
  name!: string;
}

/**
 * An error shaped as the `http-errors` package builds one, which body-parser
 * and Express raise. A plain error stands in, since the package is only a
 * transitive dependency here.
 */
const httpError = (message: string, status: number, expose: boolean) =>
  Object.assign(new Error(message), { status, statusCode: status, expose });

@Controller()
class TestController {
  @Get('boom')
  boom(): never {
    throw new Error('connect ECONNREFUSED postgres://bge:secret@db:5432');
  }

  @Get('http-error/:status/:expose')
  throwHttpError(@Param('status') status: string, @Param('expose') expose: string): never {
    throw httpError('unsupported charset "X-BOGUS"', Number(status), expose === 'true');
  }

  @Get('half-sent')
  halfSent(@Res() res: Response): never {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('partial');
    throw new Error('failed after the headers were sent');
  }

  @Post('named')
  named(@Body() dto: NamedDto): NamedDto {
    return dto;
  }

  @Get('languages/:id')
  language(@Param('id') id: string): never {
    throw new NotFoundException(t('errors.language.not_found', { id }));
  }
}

/**
 * The last-resort filter (#527, #1260) in a real HTTP app, behind the api's
 * two other global filters in their real order, with the real body parser and
 * catalog. Everything that isn't an `HttpException` reaches it: a bug's
 * `Error`, and the `http-errors` errors body-parser raises. Each must leave as
 * the error envelope with catalog copy, never the thrower's own text.
 */
describe('UnknownErrorFilter (integration, #527)', () => {
  let app: NestExpressApplication;
  let i18n: I18nService;
  let logged: jest.SpyInstance;
  let warned: jest.SpyInstance;
  const getLocale = jest.fn((): string | undefined => FALLBACK_LOCALE);
  // A second supported locale, so a header-resolved one is observable.
  const supportedLocales = { getSupportedTags: () => [FALLBACK_LOCALE, 'fr'] } as unknown as SupportedLocalesService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        I18nModule.forRoot({
          fallbackLanguage: FALLBACK_LOCALE,
          loaderOptions: { path: I18N_CATALOG_DIR, watch: false },
        }),
      ],
      controllers: [TestController],
      providers: [
        { provide: AuditContextService, useValue: { getLocale } },
        // The real header lookup, which reads no database.
        { provide: LocaleResolutionService, useValue: new LocaleResolutionService({} as never, supportedLocales) },
        // The api's order (apps/api app.module.ts). Nest tries global filters
        // in reverse registration order, so the catch-all is tried last.
        { provide: APP_FILTER, useClass: UnknownErrorFilter },
        { provide: APP_FILTER, useClass: I18nExceptionFilter },
        { provide: APP_FILTER, useValue: new I18nValidationExceptionFilter({ detailedErrors: false }) },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    app.useBodyParser('json', { limit: BODY_LIMIT });
    app.useGlobalPipes(new I18nValidationPipe({ transform: true }));
    await app.listen(0);
    i18n = app.get(I18nService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    getLocale.mockReturnValue(FALLBACK_LOCALE);
    logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const url = async (path: string) => `${await app.getUrl()}${path}`;

  describe('an error that is not an HttpException', () => {
    it("answers a 500 in the envelope with the catalog's copy, and none of the error's own text (#527)", async () => {
      const res = await fetch(await url('/boom'));
      const text = await res.text();

      expect(res.status).toBe(500);
      expect(JSON.parse(text)).toEqual({ statusCode: 500, error: 'Internal Server Error', message: FAILED_COPY });
      expect(text).not.toContain('ECONNREFUSED');
      expect(text).not.toContain('secret');
    });

    it('logs the error, as Nest does', async () => {
      await fetch(await url('/boom'));

      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('ECONNREFUSED') }),
      );
    });

    it("renders the copy in the request's locale (#527)", async () => {
      getLocale.mockReturnValue('fr');
      const translate = jest.spyOn(i18n, 'translate');

      await fetch(await url('/boom'));

      expect(translate).toHaveBeenCalledWith('errors.request.failed', expect.objectContaining({ lang: 'fr' }));
    });

    it('ends a response whose headers were already sent, rather than writing a second body', async () => {
      const res = await fetch(await url('/half-sent'));

      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe('partial');
    });
  });

  describe("body-parser's errors", () => {
    it('answers a body over the limit with a coded 413 (#527)', async () => {
      const res = await fetch(await url('/named'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x'.repeat(300 * 1024) }),
      });

      expect(res.status).toBe(413);
      await expect(res.json()).resolves.toEqual({
        statusCode: 413,
        error: 'Payload Too Large',
        code: 'REQUEST_TOO_LARGE',
        message: TOO_LARGE_COPY,
      });
      expect(logged).not.toHaveBeenCalled();
    });

    // In the api the parser runs before the locale middleware, so CLS holds no
    // locale yet: the request's Accept-Language picks it (#527).
    it("renders the 413 in the request's Accept-Language locale when CLS holds none (#527)", async () => {
      getLocale.mockReturnValue(undefined);
      const translate = jest.spyOn(i18n, 'translate');

      await fetch(await url('/named'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept-language': 'fr-CA, en;q=0.5' },
        body: JSON.stringify({ name: 'x'.repeat(300 * 1024) }),
      });

      expect(translate).toHaveBeenCalledWith('errors.request.too_large', expect.objectContaining({ lang: 'fr' }));
    });

    it("keeps another 4xx's status, and answers it with the catalog's copy rather than the parser's (#527)", async () => {
      const res = await fetch(await url('/named'), {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=x-bogus' },
        body: JSON.stringify({ name: 'Gloomhaven' }),
      });
      const text = await res.text();

      expect(res.status).toBe(415);
      expect(JSON.parse(text)).toEqual({ statusCode: 415, error: 'Unsupported Media Type', message: UNREADABLE_COPY });
      expect(text).not.toContain('charset');
      // The parser's text goes to the log only (#527).
      expect(warned).toHaveBeenCalledWith(expect.stringContaining('unsupported charset'));
    });

    it('answers a 4xx the thrower marked unexposed as a 500, and logs it', async () => {
      const res = await fetch(await url('/http-error/415/false'));

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({
        statusCode: 500,
        error: 'Internal Server Error',
        message: FAILED_COPY,
      });
      expect(logged).toHaveBeenCalled();
    });

    it('answers a 5xx as a 500 with no detail, and logs it', async () => {
      const res = await fetch(await url('/http-error/503/false'));
      const text = await res.text();

      expect(res.status).toBe(500);
      expect(JSON.parse(text)).toEqual({ statusCode: 500, error: 'Internal Server Error', message: FAILED_COPY });
      expect(text).not.toContain('charset');
      expect(logged).toHaveBeenCalled();
    });
  });

  describe('an HttpException', () => {
    it('still reaches the validation filter, which answers as before', async () => {
      const res = await fetch(await url('/named'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 42 }),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['name must be a string'],
      });
    });

    it('still reaches I18nExceptionFilter, which answers as before', async () => {
      const res = await fetch(await url('/languages/42'));

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({
        statusCode: 404,
        error: 'Not Found',
        message: 'Language with id 42 not found',
      });
      expect(logged).not.toHaveBeenCalled();
    });
  });
});
