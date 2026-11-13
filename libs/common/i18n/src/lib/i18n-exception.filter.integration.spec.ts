/* eslint-disable bge/no-uncoded-exception-body -- these cases hand the renderer a coded body no producer may build, to pin that it completes any body into the envelope (#1260) */
import { AuditContextService } from '@bge/actor-context';
import { t } from '@bge/i18n-core';
import {
  ConflictException,
  Controller,
  Get,
  type INestApplication,
  type MiddlewareConsumer,
  Module,
  type NestMiddleware,
  type NestModule,
  NotFoundException,
  Param,
  ServiceUnavailableException,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { I18nService } from 'nestjs-i18n';
import { CodedHttpException } from './coded-http.exception';
import { I18nExceptionFilter } from './i18n-exception.filter';
import { LocaleResolutionService } from './locale-resolution.service';

/**
 * Boots a real (minimal) Nest HTTP app so the filter is exercised end-to-end:
 * DI resolution via `APP_FILTER`, `super.catch` rendering over the wire, and
 * locale flowing from `AuditContextService`. `I18nService` / `AuditContextService`
 * are stubbed so no catalog/DB/CLS is needed.
 */
@Controller('languages')
class TestController {
  @Get('translated/:id')
  translated(@Param('id') id: string): never {
    throw new NotFoundException(t('errors.language.not_found', { id }));
  }

  @Get('plain')
  plain(): never {
    throw new NotFoundException('plain english message');
  }

  @Get('coded')
  coded(): never {
    throw new ConflictException({ code: 'CATALOG_ENTRY_CHANGED', message: 'plain english message' });
  }

  // What Terminus throws when a readiness check fails.
  @Get('health')
  health(): never {
    throw new ServiceUnavailableException({
      status: 'error',
      info: {},
      error: { database: { status: 'down', message: 'connection refused' } },
      details: { database: { status: 'down', message: 'connection refused' } },
    });
  }
}

// Mounted as the api mounts its own middleware, `forRoutes('*')`, Express runs
// it outside any route, so a request it refuses has no `req.route`: the same
// signal Nest's not-found answer gives. It refuses one path only, as
// HttpActorMiddleware refuses some requests (#634).
class MissingMiddleware implements NestMiddleware {
  use(req: { readonly originalUrl: string }, _res: unknown, next: (error?: unknown) => void): void {
    if (!req.originalUrl.startsWith('/missing')) {
      next();
      return;
    }

    next(new CodedHttpException(404, 'ENTRY_NOT_FOUND', t('errors.language.not_found', { id: '7' })));
  }
}

@Module({})
class MissingModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(MissingMiddleware).forRoutes('*');
  }
}

describe('I18nExceptionFilter (integration)', () => {
  let app: INestApplication;
  const translate = jest.fn();
  const getLocale = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MissingModule],
      controllers: [TestController],
      providers: [
        { provide: I18nService, useValue: { translate } },
        { provide: AuditContextService, useValue: { getLocale } },
        { provide: LocaleResolutionService, useValue: { resolveAcceptLanguage: () => 'en' } },
        { provide: APP_FILTER, useClass: I18nExceptionFilter },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  it('renders a translated 404 body for an i18n-carrying exception', async () => {
    getLocale.mockReturnValue('fr');
    translate.mockReturnValue('Langue introuvable (42)');

    const res = await fetch(`${await app.getUrl()}/languages/translated/42`);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      statusCode: 404,
      message: 'Langue introuvable (42)',
      error: 'Not Found',
    });
    expect(translate).toHaveBeenCalledWith('errors.language.not_found', { lang: 'fr', args: { id: '42' } });
  });

  it('leaves a non-i18n exception with the default Nest body', async () => {
    const res = await fetch(`${await app.getUrl()}/languages/plain`);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      statusCode: 404,
      message: 'plain english message',
      error: 'Not Found',
    });
    expect(translate).not.toHaveBeenCalled();
  });

  it('sends a coded body that carries only code and message as the full envelope (#1260)', async () => {
    const res = await fetch(`${await app.getUrl()}/languages/coded`);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: 'plain english message',
      code: 'CATALOG_ENTRY_CHANGED',
    });
  });

  describe('a 404', () => {
    beforeEach(() => translate.mockImplementation((key: string) => `t:${key}`));

    // Nest's own 404 says `Cannot GET /x`, the same shape as a missing row's,
    // so a client could read a moved route as "already removed" (#634).
    it.each([
      ['GET', '/nope'],
      ['DELETE', '/languages/translated/42/entries'],
      ['DELETE', '/languages/translated/'],
    ])(
      'for %s %s, which no route matches, carries ROUTE_NOT_FOUND and catalog copy (#634, #527)',
      async (method, path) => {
        const res = await fetch(`${await app.getUrl()}${path}`, { method });
        const text = await res.text();

        expect(res.status).toBe(404);
        expect(JSON.parse(text)).toEqual({
          statusCode: 404,
          error: 'Not Found',
          code: 'ROUTE_NOT_FOUND',
          message: 't:errors.request.route_not_found',
        });
        expect(text).not.toContain(path);
      },
    );

    it('thrown by a matched route carries no ROUTE_NOT_FOUND, however it was thrown (#634)', async () => {
      const marked = await fetch(`${await app.getUrl()}/languages/translated/42`);
      const plain = await fetch(`${await app.getUrl()}/languages/plain`);

      await expect(marked.json()).resolves.toEqual({
        statusCode: 404,
        error: 'Not Found',
        message: 't:errors.language.not_found',
      });
      await expect(plain.json()).resolves.toEqual({
        statusCode: 404,
        error: 'Not Found',
        message: 'plain english message',
      });
    });

    it('thrown before routing with its own code keeps that code (#634)', async () => {
      const res = await fetch(`${await app.getUrl()}/missing/7`);

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({
        statusCode: 404,
        error: 'Not Found',
        code: 'ENTRY_NOT_FOUND',
        message: 't:errors.language.not_found',
      });
    });
  });

  it('sends a failed health check in the envelope, its failures still named in `details` (#1260)', async () => {
    const res = await fetch(`${await app.getUrl()}/languages/health`);

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Service Unavailable',
      status: 'error',
      info: {},
      details: { database: { status: 'down', message: 'connection refused' } },
    });
  });
});
