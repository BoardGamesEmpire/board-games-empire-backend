import { API_KEY_HEADER } from '@bge/actor-context-transport';
import { CodedHttpException, t } from '@bge/i18n';
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Http } from '@status/codes';
import type { SwaggerConfig } from '../configuration/swagger.config';

const LOGGER_CONTEXT = 'ApiDocument';

/**
 * Where the API document is mounted, without a leading slash (#1511). Its page
 * answers here, and the JSON and YAML forms below it. The operational gate's
 * routes name the same path, so moving the mount can't put the document on the
 * public port.
 */
export const API_DOCUMENT_PATH = 'docs';

const API_DOCUMENT_JSON_PATH = `${API_DOCUMENT_PATH}/json`;
const API_DOCUMENT_YAML_PATH = `${API_DOCUMENT_PATH}/yaml`;

export interface ApiDocumentSources {
  /** The document's header, from the `swagger` configuration. */
  readonly config: SwaggerConfig;

  /** Where main.ts mounts the api's routes, and better-auth's under it. */
  readonly globalPrefix: string;

  /** Reads better-auth's own OpenAPI schema (`auth.api.generateOpenAPISchema`). */
  readonly loadAuthSchema: () => Promise<OpenAPIObject>;
}

/**
 * The whole API document, the api's routes with better-auth's merged in
 * (#1511). It needs no listener, so #635's CI export can build the document
 * from an app that never serves it. A failed read of better-auth's schema
 * rejects as it was thrown.
 */
export async function buildApiDocument(
  app: INestApplication,
  { config, globalPrefix, loadAuthSchema }: ApiDocumentSources,
): Promise<OpenAPIObject> {
  return mergeAuthSchema(createBaseDocument(app, config), await loadAuthSchema(), globalPrefix);
}

/**
 * Serves the API document at {@link API_DOCUMENT_PATH} (#1511): the page, and
 * the document as JSON and YAML. The operational gate keeps all of it off the
 * public port.
 *
 * Nothing is built here. Swagger calls the factory, and the patch that merges
 * better-auth's half in ({@link createAuthSchemaPatch}), on the first request:
 * reading better-auth's schema can wait on a sign-in provider's discovery
 * (DEPLOYMENT.md), which would otherwise hold up the listen.
 */
export function setupApiDocument(
  app: INestApplication,
  { config, globalPrefix, loadAuthSchema }: ApiDocumentSources,
): void {
  SwaggerModule.setup(API_DOCUMENT_PATH, app, () => createBaseDocument(app, config), {
    jsonDocumentUrl: API_DOCUMENT_JSON_PATH,
    yamlDocumentUrl: API_DOCUMENT_YAML_PATH,
    patchDocumentOnRequest: createAuthSchemaPatch(loadAuthSchema, globalPrefix),
  });
}

/** The api's own half of the document: its header, its security schemes and its routes. */
function createBaseDocument(app: INestApplication, { description, title, version }: SwaggerConfig): OpenAPIObject {
  const header = new DocumentBuilder()
    .setTitle(title)
    .setDescription(description)
    .setVersion(version)
    .addBearerAuth()
    .addApiKey({
      type: 'apiKey',
      // The header HttpActorMiddleware reads a key from (#1418).
      name: API_KEY_HEADER,
      in: 'header',
    })
    .build();

  return SwaggerModule.createDocument(app, header);
}

/**
 * The api's own OpenAPI document with better-auth's merged in (#1511).
 * better-auth describes its routes from its own base path, so each of its
 * paths goes under `/<globalPrefix>/auth`, where main.ts mounts it, unless it
 * is already written there. The api's document keeps its header and security
 * schemes; where both name one path or one schema, better-auth's entry wins,
 * as it describes its own routes. Neither document is changed.
 */
export function mergeAuthSchema(base: OpenAPIObject, auth: OpenAPIObject, globalPrefix: string): OpenAPIObject {
  const mount = `/${globalPrefix}/auth`;
  const authPaths = Object.fromEntries(
    Object.entries(auth.paths).map(([path, item]) => [path.startsWith(mount) ? path : `${mount}${path}`, item]),
  );

  return {
    ...base,
    paths: { ...base.paths, ...authPaths },
    components: {
      ...base.components,
      schemas: { ...base.components?.schemas, ...auth.components?.schemas },
    },
  };
}

/**
 * Swagger's `patchDocumentOnRequest` for the API document, which merges
 * better-auth's schema in on the first request rather than at boot (#1511).
 * Reading that schema waits on the same hold a sign-in provider's discovery
 * can put on `/api/auth`, so building it at boot would hold up the listen.
 *
 * The merged document is kept, and requests that arrive while it is being
 * built share the one read. A failed read or merge is not kept: each request
 * that waited on it is refused with a coded 503 and the next one tries again.
 * Swagger's handlers are async, so Express 5 passes the refusal to Nest's
 * error handler, which answers it in the error envelope.
 *
 * Swagger hands every request the same base document, which it builds once,
 * so the first request's merge serves them all.
 */
export function createAuthSchemaPatch(
  load: () => Promise<OpenAPIObject>,
  globalPrefix: string,
): (req: unknown, res: unknown, base: OpenAPIObject) => Promise<OpenAPIObject> {
  let merged: Promise<OpenAPIObject> | undefined;

  return (_req, _res, base) => {
    merged ??= Promise.resolve()
      .then(load)
      .then((auth) => mergeAuthSchema(base, auth, globalPrefix))
      .catch((error: unknown) => {
        merged = undefined;
        throw unavailable(error);
      });

    return merged;
  };
}

/**
 * The refusal for a document that couldn't be built. The error filter answers
 * an HTTP exception without logging its cause, so the cause is logged here,
 * as message and stack: the logger drops an Error passed as an argument.
 */
function unavailable(cause: unknown): CodedHttpException {
  const reason = cause instanceof Error ? cause.message : String(cause);
  const stack = cause instanceof Error ? (cause.stack ?? reason) : reason;
  Logger.error(`The API document couldn't be built with better-auth's schema: ${reason}`, stack, LOGGER_CONTEXT);

  return new CodedHttpException(
    Http.ServiceUnavailable,
    'API_DOCUMENT_UNAVAILABLE',
    t('errors.api_document.unavailable'),
    { cause },
  );
}
