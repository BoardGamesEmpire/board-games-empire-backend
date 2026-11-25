import { AuditContextService } from '@bge/actor-context';
import { I18nExceptionFilter, LocaleResolutionService } from '@bge/i18n';
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { OpenAPIObject } from '@nestjs/swagger';
import { SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { I18nService } from 'nestjs-i18n';
import { createAuthSchemaPatch } from './api-document';

const AUTH_SCHEMA: OpenAPIObject = {
  openapi: '3.1.1',
  info: { title: 'Better Auth', version: '1' },
  paths: { '/sign-in/email': { post: { responses: {} } } },
};

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
    SwaggerModule.setup(
      'docs',
      app,
      () => SwaggerModule.createDocument(app, { openapi: '3.0.0', info: { title: 'api', version: '1' } }),
      {
        jsonDocumentUrl: 'docs/json',
        yamlDocumentUrl: 'docs/yaml',
        patchDocumentOnRequest: createAuthSchemaPatch(load, 'api'),
      },
    );
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
