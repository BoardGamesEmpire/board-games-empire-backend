/* eslint-disable bge/no-uncoded-exception-body -- these cases hand the renderer a coded body no producer may build, to pin that it completes any body into the envelope (#1260) */
import { AuditContextService } from '@bge/actor-context';
import { t } from '@bge/i18n-core';
import {
  ConflictException,
  Controller,
  Get,
  type INestApplication,
  NotFoundException,
  Param,
  ServiceUnavailableException,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { I18nService } from 'nestjs-i18n';
import { I18nExceptionFilter } from './i18n-exception.filter';

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

describe('I18nExceptionFilter (integration)', () => {
  let app: INestApplication;
  const translate = jest.fn();
  const getLocale = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TestController],
      providers: [
        { provide: I18nService, useValue: { translate } },
        { provide: AuditContextService, useValue: { getLocale } },
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
