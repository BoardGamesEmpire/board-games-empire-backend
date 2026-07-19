import { AuditContextService } from '@bge/actor-context';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { I18nModule } from 'nestjs-i18n';
import * as path from 'node:path';
import { I18nResponseInterceptor } from './i18n-response.interceptor';
import { FALLBACK_LOCALE } from './locale.constants';
import { t } from './translatable';

/**
 * End-to-end coverage for the success-path interceptor against the REAL shipped
 * `en` catalog (mirrors `i18n-exception.filter.catalog.spec.ts` for the error
 * path). Proves a `t()` marker embedded in a success body is rendered to its
 * translated string before serialization, that it is found when nested, and
 * that marker-free bodies are untouched.
 *
 * `__dirname` is `src/lib` under jest (unbundled source), so `./i18n` is the
 * same catalog the app ships as a webpack asset.
 */
@Controller('games')
class TestController {
  @Get('created')
  created() {
    return { game: { id: 'game-1' }, message: t('success.game.created') };
  }

  @Get('nested')
  nested() {
    return { data: { items: [{ note: t('success.game.deleted') }] } };
  }

  @Get('plain')
  plain() {
    return { game: { id: 'game-1' }, message: 'literal-untouched' };
  }

  @Get('cached')
  cached() {
    // Simulates a Valkey response-cache hit. This interceptor sits OUTSIDE the
    // cache interceptor, so on a hit it receives the body rehydrated from JSON:
    // the marker arrives as a prototype-less plain object, not an I18nMessage
    // instance. It must still be resolved (regression for the `instanceof` gap).
    return JSON.parse(JSON.stringify({ game: { id: 'game-1' }, message: t('success.game.created') }));
  }
}

describe('I18nResponseInterceptor (real catalog)', () => {
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
        { provide: APP_INTERCEPTOR, useClass: I18nResponseInterceptor },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  it('renders a top-level `message` marker against the shipped en catalog', async () => {
    const res = await fetch(`${await app.getUrl()}/games/created`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      game: { id: 'game-1' },
      message: 'Game created successfully',
    });
  });

  it('finds and renders a marker nested inside objects and arrays', async () => {
    const res = await fetch(`${await app.getUrl()}/games/nested`);

    await expect(res.json()).resolves.toEqual({
      data: { items: [{ note: 'Game deleted successfully' }] },
    });
  });

  it('leaves a marker-free body (plain string) unchanged', async () => {
    const res = await fetch(`${await app.getUrl()}/games/plain`);

    await expect(res.json()).resolves.toEqual({
      game: { id: 'game-1' },
      message: 'literal-untouched',
    });
  });

  it('renders a marker rehydrated from JSON (response-cache hit)', async () => {
    const res = await fetch(`${await app.getUrl()}/games/cached`);

    await expect(res.json()).resolves.toEqual({
      game: { id: 'game-1' },
      message: 'Game created successfully',
    });
  });
});
