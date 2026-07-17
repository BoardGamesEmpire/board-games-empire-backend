import { AuditContextService } from '@bge/actor-context';
import { Controller, Get, type INestApplication, NotFoundException, Param } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { I18nService } from 'nestjs-i18n';
import { I18nExceptionFilter } from './i18n-exception.filter';
import { t } from './translatable';

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
});
