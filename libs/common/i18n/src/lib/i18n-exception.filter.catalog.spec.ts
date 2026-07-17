import { AuditContextService } from '@bge/actor-context';
import { Controller, Get, type INestApplication, NotFoundException, Param } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { I18nModule } from 'nestjs-i18n';
import * as path from 'node:path';
import { I18nExceptionFilter } from './i18n-exception.filter';
import { FALLBACK_LOCALE } from './locale.constants';
import { t } from './translatable';

/**
 * Complements the (stubbed-`I18nService`) integration spec by exercising the
 * REAL translation path end-to-end: a real `I18nService` loaded from the shipped
 * `en` catalog resolves the key and interpolates `{id}`. This is the only spec
 * that would catch a catalog placeholder-syntax mismatch, a renamed/missing
 * catalog file, or a wrong loader path — the stubs elsewhere cannot.
 *
 * `__dirname` here is `src/lib` (jest runs the unbundled source), so
 * `./i18n` is the same catalog directory the app ships as a webpack asset.
 * No resolver is configured — the filter always translates with an explicit
 * `lang`, so `I18nContext` is unnecessary.
 */
@Controller('languages')
class TestController {
  @Get('translated/:id')
  translated(@Param('id') id: string): never {
    throw new NotFoundException(t('errors.language.not_found', { id }));
  }
}

describe('I18nExceptionFilter (real catalog)', () => {
  let app: INestApplication;
  const getLocale = jest.fn().mockReturnValue(FALLBACK_LOCALE);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        I18nModule.forRoot({
          fallbackLanguage: FALLBACK_LOCALE,
          loaderOptions: { path: path.join(__dirname, 'i18n'), watch: false },
        }),
      ],
      controllers: [TestController],
      providers: [
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

  it('resolves the key against the shipped en catalog and interpolates args', async () => {
    const res = await fetch(`${await app.getUrl()}/languages/translated/42`);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      statusCode: 404,
      message: 'Language with id 42 not found',
      error: 'Not Found',
    });
  });
});
