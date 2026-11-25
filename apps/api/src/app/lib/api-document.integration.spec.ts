import { AuditContextService } from '@bge/actor-context';
import { I18nExceptionFilter, LocaleResolutionService } from '@bge/i18n';
import type { INestApplication } from '@nestjs/common';
import { Controller, Get, Logger } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { I18nService } from 'nestjs-i18n';
import { buildApiDocument, setupApiDocument } from './api-document';

const AUTH_SCHEMA: OpenAPIObject = {
  openapi: '3.1.1',
  info: { title: 'Better Auth', version: '1' },
  paths: { '/sign-in/email': { post: { responses: {} } } },
};

const HEADER = { title: 'Board Games Empire API', description: 'The api', version: '1.2.3' };

@Controller('games')
class GamesController {
  @Get()
  list(): string[] {
    return [];
  }
}

/**
 * The whole API document, built by the one function #635's CI export calls
 * (#1511): the api's routes from a Nest app that never listens, with
 * better-auth's merged in under its mount.
 */
describe('buildApiDocument (#1511)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [GamesController] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
  });

  afterEach(() => app.close());

  it("builds the api's half and better-auth's into one document, without serving it", async () => {
    const loadAuthSchema = jest.fn(async () => AUTH_SCHEMA);

    const document = await buildApiDocument(app, { config: HEADER, loadAuthSchema, globalPrefix: 'api' });

    expect(document.info).toMatchObject(HEADER);
    expect(Object.keys(document.paths).sort()).toEqual(['/api/auth/sign-in/email', '/api/games']);
    expect(loadAuthSchema).toHaveBeenCalledTimes(1);
  });

  it('describes the two ways a client authenticates: a bearer token and an x-api-key header (#1418)', async () => {
    const document = await buildApiDocument(app, {
      config: HEADER,
      loadAuthSchema: async () => AUTH_SCHEMA,
      globalPrefix: 'api',
    });

    expect(Object.values(document.components?.securitySchemes ?? {})).toEqual([
      expect.objectContaining({ type: 'http', scheme: 'bearer' }),
      { type: 'apiKey', name: 'x-api-key', in: 'header' },
    ]);
  });

  // Swagger serves the document through its own factory and patch, not
  // through buildApiDocument, so this pins the two to one document: #635's
  // export must publish what /docs serves.
  it('builds the same document the API document page serves', async () => {
    const sources = { config: HEADER, loadAuthSchema: async () => AUTH_SCHEMA, globalPrefix: 'api' };
    setupApiDocument(app, sources);
    await app.listen(0);

    const served = await fetch(`${await app.getUrl()}/docs/json`);

    expect(served.status).toBe(200);
    await expect(served.json()).resolves.toEqual(JSON.parse(JSON.stringify(await buildApiDocument(app, sources))));
  });
});

/**
 * A failed read of better-auth's schema, over the wire (#1511). Swagger's
 * handlers are async Express handlers, and Express 5 hands a rejected one to
 * `next`, where Nest's error handler runs the global filters: the request is
 * answered in the error envelope, not left hanging, and the next one tries
 * again. The api's own filter, with the catalog stubbed.
 */
describe('the API document when better-auth cannot give its schema (#1511)', () => {
  let app: INestApplication;
  let url: string;
  const load = jest.fn<Promise<OpenAPIObject>, []>();

  // A new app for each case, since the patch keeps the document it builds.
  beforeEach(async () => {
    load.mockReset();
    jest.spyOn(Logger, 'error').mockImplementation(() => undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: I18nService, useValue: { translate: (key: string) => `rendered ${key}` } },
        { provide: AuditContextService, useValue: { getLocale: () => 'en' } },
        { provide: LocaleResolutionService, useValue: { resolveAcceptLanguage: () => 'en' } },
        { provide: APP_FILTER, useClass: I18nExceptionFilter },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    setupApiDocument(app, { config: HEADER, loadAuthSchema: load, globalPrefix: 'api' });
    await app.listen(0);
    url = await app.getUrl();
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it.each(['/docs/json', '/docs/yaml', '/docs/swagger-ui-init.js'])(
    'answers %s with a coded 503 in the error envelope, then serves it on the next request',
    async (path) => {
      load.mockRejectedValueOnce(new Error('database unreachable')).mockResolvedValueOnce(AUTH_SCHEMA);

      const refused = await fetch(`${url}${path}`);

      expect(refused.status).toBe(503);
      expect(refused.headers.get('content-type')).toMatch(/^application\/json/);
      await expect(refused.json()).resolves.toEqual({
        statusCode: 503,
        error: 'Service Unavailable',
        code: 'API_DOCUMENT_UNAVAILABLE',
        message: 'rendered errors.api_document.unavailable',
      });

      const served = await fetch(`${url}${path}`);

      expect(served.status).toBe(200);
      expect(load).toHaveBeenCalledTimes(2);
    },
  );
});
