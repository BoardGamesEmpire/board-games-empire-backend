import { AuditContextService } from '@bge/actor-context';
import { I18N_CATALOG_DIR, t } from '@bge/i18n-core';
import { Body, Controller, Get, type INestApplication, NotFoundException, Param, Post } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ArrayNotEmpty, ArrayUnique, IsEnum, IsIn, IsOptional, IsString } from 'class-validator';
import { I18nModule, I18nValidationExceptionFilter, I18nValidationPipe } from 'nestjs-i18n';
import { I18nExceptionFilter } from './i18n-exception.filter';
import { FALLBACK_LOCALE } from './locale.constants';
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
 * `I18N_CATALOG_DIR` is the shipped catalog. No resolver is configured;
 * `I18nModule` applies `I18nMiddleware` for all routes, which creates the
 * request `I18nContext` at `fallbackLanguage`.
 */
class ValidateDto {
  @IsString({ message: i18nValidationMessage('validation.isString') })
  name!: string;
}

class ValidateArrayDto {
  @ArrayNotEmpty({ message: i18nValidationMessage('validation.arrayNotEmpty') })
  @ArrayUnique({ message: i18nValidationMessage('validation.arrayUnique') })
  tags!: string[];
}

enum Color {
  Red = 'red',
  Green = 'green',
}

const ACTIONS = ['create', 'update', 'delete'];

class ValidateListDto {
  @IsOptional()
  @IsIn(ACTIONS, { message: i18nValidationMessage('validation.isIn') })
  action?: string;

  @IsOptional()
  @IsEnum(Color, { message: i18nValidationMessage('validation.isEnum') })
  color?: Color;

  @IsOptional()
  @IsString({ each: true, message: i18nValidationMessage('validation.each.isString') })
  names?: string[];

  @IsOptional()
  @IsIn(ACTIONS, { each: true, message: i18nValidationMessage('validation.each.isIn') })
  actions?: string[];
}

@Controller()
class TestController {
  @Post('validate')
  validate(@Body() dto: ValidateDto): ValidateDto {
    return dto; // only the failure path is exercised; echo keeps the param used
  }

  @Post('validate-array')
  validateArray(@Body() dto: ValidateArrayDto): ValidateArrayDto {
    return dto;
  }

  @Post('validate-list')
  validateList(@Body() dto: ValidateListDto): ValidateListDto {
    return dto;
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
          loaderOptions: { path: I18N_CATALOG_DIR, watch: false },
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

  // The catalog copies class-validator's own defaults, so these must render
  // exactly what an untagged decorator said before.
  it.each([
    ['an empty array', [], 'tags should not be empty'],
    ['a duplicate entry', ['a', 'a'], "All tags's elements must be unique"],
  ])('renders the array constraints in class-validator wording (%s)', async (_case, tags, expected) => {
    const res = await fetch(`${await app.getUrl()}/validate-array`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ statusCode: 400, message: [expected], error: 'Bad Request' });
  });

  // Expected copy is what class-validator's own defaults print for the same
  // decorators: a list constraint joined with ", ", and the "each value in "
  // prefix an `each: true` default carries.
  it.each([
    ['an IsIn list', { action: 'upsert' }, 'action must be one of the following values: create, update, delete'],
    ['an IsEnum list', { color: 'blue' }, 'color must be one of the following values: red, green'],
    ['an each: true IsString', { names: [1] }, 'each value in names must be a string'],
    [
      'an each: true IsIn',
      { actions: ['bogus'] },
      'each value in actions must be one of the following values: create, update, delete',
    ],
  ])('renders %s in class-validator wording', async (_case, body, expected) => {
    const res = await fetch(`${await app.getUrl()}/validate-list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ statusCode: 400, message: [expected], error: 'Bad Request' });
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
