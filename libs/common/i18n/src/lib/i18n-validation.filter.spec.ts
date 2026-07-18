import { AuditContextService } from '@bge/actor-context';
import { Body, Controller, Get, type INestApplication, NotFoundException, Param, Post } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { IsString } from 'class-validator';
import { I18nModule, I18nValidationExceptionFilter, I18nValidationPipe } from 'nestjs-i18n';
import * as path from 'node:path';
import { I18nExceptionFilter } from './i18n-exception.filter';
import { FALLBACK_LOCALE } from './locale.constants';
import { t } from './translatable';
import { i18nValidationMessage } from './validation-message';

/**
 * End-to-end proof of the #142 validation machinery AND its interaction with the
 * #143 `t()` filter — the two are registered together in `apps/api`.
 *
 * Two things are asserted that unit tests can't:
 *  1. A decorator tagged with `i18nValidationMessage('validation.*')` resolves
 *     against the shipped `en` catalog and renders the pre-i18n body shape
 *     `{ statusCode, message: string[], error }` (the plain-ValidationPipe
 *     contract). This also proves an `I18nContext` exists at pipe/filter time —
 *     otherwise the filter would throw and the request would 500.
 *  2. Filter ORDER: `I18nValidationException` is itself an `HttpException`, so
 *     the catch-all `I18nExceptionFilter` (`@Catch(HttpException)`) would also
 *     match it. Nest evaluates global filters in reverse registration order, so
 *     registering the validation filter LAST makes it win for validation errors
 *     while the catch-all still translates `t()` exceptions. If the order ever
 *     regresses, the validation assertion below fails (the catch-all would
 *     render `{ message: 'Bad Request' }`, dropping the field errors).
 *
 * `__dirname` is `src/lib` under jest (unbundled), so `./i18n` is the shipped
 * catalog. No resolver is configured; `I18nModule` applies `I18nMiddleware` for
 * all routes, which creates the request `I18nContext` at `fallbackLanguage`.
 */
class ValidateDto {
  @IsString({ message: i18nValidationMessage('validation.isString') })
  name!: string;
}

@Controller()
class TestController {
  @Post('validate')
  validate(@Body() dto: ValidateDto): ValidateDto {
    return dto; // only the failure path is exercised; echo keeps the param used
  }

  @Get('translated/:id')
  translated(@Param('id') id: string): never {
    throw new NotFoundException(t('errors.language.not_found', { id }));
  }
}

describe('I18nValidationExceptionFilter + I18nExceptionFilter (real catalog)', () => {
  let app: INestApplication;

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
        { provide: AuditContextService, useValue: { getLocale: () => FALLBACK_LOCALE } },
        // Same order as apps/api: catch-all first, validation last (so Nest's
        // reversed global-filter order checks validation first).
        { provide: APP_FILTER, useClass: I18nExceptionFilter },
        { provide: APP_FILTER, useValue: new I18nValidationExceptionFilter({ detailedErrors: false }) },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new I18nValidationPipe({ transform: true }));
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  it('renders a validation error from the validation catalog in the pre-i18n body shape', async () => {
    const res = await fetch(`${await app.getUrl()}/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 123 }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      statusCode: 400,
      message: ['name must be a string'],
      error: 'Bad Request',
    });
  });

  it('still routes a t() HttpException to the catch-all filter (ordering intact)', async () => {
    const res = await fetch(`${await app.getUrl()}/translated/42`);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      statusCode: 404,
      message: 'Language with id 42 not found',
      error: 'Not Found',
    });
  });
});
