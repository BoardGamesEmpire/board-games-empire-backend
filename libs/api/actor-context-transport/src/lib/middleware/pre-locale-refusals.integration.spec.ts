import { AuditContextInternalService, AuditContextService } from '@bge/actor-context';
import { AuthService } from '@bge/auth';
import { FALLBACK_LOCALE, I18N_CATALOG_DIR, I18nExceptionFilter, LocaleResolutionService, t } from '@bge/i18n';
import {
  Controller,
  Get,
  type INestApplication,
  Logger,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  NotFoundException,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ClsMiddleware, ClsModule } from 'nestjs-cls';
import { I18nModule } from 'nestjs-i18n';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { API_KEY_HEADER, HttpActorMiddleware } from './http-actor.middleware';
import { LocaleResolutionMiddleware } from './locale-resolution.middleware';

// A second catalog for this spec only, since only `en` ships (#508).
const FRENCH = {
  api_key: { invalid: "Clé d'API non valide" },
  auth: { impersonated_session: "Les sessions d'emprunt d'identité ne sont pas prises en charge" },
  language: { not_found: 'Aucune langue avec l’identifiant {id}' },
};

/** Who each session cookie names, and the language each user stored. */
const SESSIONS: Record<string, { userId: string; impersonatedBy?: string }> = {
  impersonated: { userId: 'user-target', impersonatedBy: 'user-admin' },
  'prefers-fr': { userId: 'user-fr' },
  'prefers-en': { userId: 'user-en' },
};
const PREFERENCES: Record<string, string> = { 'user-fr': 'fr', 'user-en': 'en' };

const auth = {
  hasSessionCredential: (headers: { cookie?: string }) => headers.cookie !== undefined,
  verifyApiKey: async () => null,
  getSessionFromHeaders: async (headers: { cookie?: string }) => {
    const session = SESSIONS[headers.cookie ?? ''];
    return session
      ? {
          user: { id: session.userId, isAnonymous: false },
          session: { impersonatedBy: session.impersonatedBy ?? null },
        }
      : null;
  },
};

const db = {
  userPreferences: {
    findUnique: async ({ where }: { where: { userId: string } }) => {
      const tag = PREFERENCES[where.userId];
      return tag ? { languageTag: { tag } } : null;
    },
  },
};

@Controller('languages')
class LanguagesController {
  // A refusal thrown after the locale middleware ran.
  @Get('missing')
  missing(): never {
    throw new NotFoundException(t('errors.language.not_found', { id: '42' }));
  }
}

// The api's entry seam, in AppModule's order: the actor first, then the
// locale, whose precedence chain starts with the actor's stored preference.
@Module({
  providers: [
    AuditContextService,
    AuditContextInternalService,
    { provide: AuthService, useValue: auth },
    {
      provide: LocaleResolutionService,
      useValue: new LocaleResolutionService(db as never, { getSupportedTags: () => [FALLBACK_LOCALE, 'fr'] } as never),
    },
  ],
  exports: [AuditContextService, LocaleResolutionService],
})
class EntrySeamModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ClsMiddleware, HttpActorMiddleware, LocaleResolutionMiddleware).forRoutes('*');
  }
}

/**
 * HttpActorMiddleware refuses before LocaleResolutionMiddleware has run, so
 * CLS holds no locale when the global filter renders its refusals. The filter
 * then reads the request's `Accept-Language` alone, since the stored
 * preference needs the actor this middleware failed to resolve (#508). Booted
 * over a real Nest HTTP app with the shipped `en` catalog and a test-only `fr`.
 */
describe('Refusals thrown before the locale exists (#508)', () => {
  let app: INestApplication;
  let catalogDir: string;

  beforeAll(async () => {
    catalogDir = mkdtempSync(path.join(tmpdir(), 'bge-i18n-508-'));
    cpSync(path.join(I18N_CATALOG_DIR, FALLBACK_LOCALE), path.join(catalogDir, FALLBACK_LOCALE), { recursive: true });
    mkdirSync(path.join(catalogDir, 'fr'));
    writeFileSync(path.join(catalogDir, 'fr', 'errors.json'), JSON.stringify(FRENCH));

    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: false } }),
        I18nModule.forRoot({ fallbackLanguage: FALLBACK_LOCALE, loaderOptions: { path: catalogDir, watch: false } }),
        EntrySeamModule,
      ],
      controllers: [LanguagesController],
      providers: [{ provide: APP_FILTER, useClass: I18nExceptionFilter }],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
    rmSync(catalogDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const get = async (urlPath: string, headers: Record<string, string>) => {
    const res = await fetch(`${await app.getUrl()}${urlPath}`, { headers });
    return { status: res.status, body: (await res.json()) as { message: string } };
  };

  describe("HttpActorMiddleware's refusals render in the Accept-Language locale", () => {
    it('an invalid API key', async () => {
      const res = await get('/languages/missing', {
        [API_KEY_HEADER]: 'bad-key',
        'accept-language': 'fr-CA, en;q=0.5',
      });

      expect(res.status).toBe(401);
      expect(res.body.message).toBe(FRENCH.api_key.invalid);
    });

    it('an impersonated session', async () => {
      const res = await get('/languages/missing', { cookie: 'impersonated', 'accept-language': 'fr' });

      expect(res.status).toBe(403);
      expect(res.body.message).toBe(FRENCH.auth.impersonated_session);
    });

    it('and in the fallback locale when the header names none the server ships', async () => {
      const res = await get('/languages/missing', { [API_KEY_HEADER]: 'bad-key', 'accept-language': 'pt-BR' });

      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Invalid API key');
    });
  });

  // The header is a fallback only: once the locale middleware has run, the
  // locale it stored, the user's preference first, is the one used.
  describe('a refusal thrown after the locale middleware ran', () => {
    it("renders in the user's stored language over the header", async () => {
      const res = await get('/languages/missing', { cookie: 'prefers-fr', 'accept-language': 'en' });

      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Aucune langue avec l’identifiant 42');
    });

    it("keeps the user's stored language when the header asks for another the server ships", async () => {
      const res = await get('/languages/missing', { cookie: 'prefers-en', 'accept-language': 'fr' });

      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Language with id 42 not found');
    });
  });
});
