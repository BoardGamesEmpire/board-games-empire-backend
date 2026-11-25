import { CodedHttpException, t } from '@bge/i18n';
import { Logger } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { Http } from '@status/codes';

const LOGGER_CONTEXT = 'ApiDocument';

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
