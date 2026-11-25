import { CodedHttpException } from '@bge/i18n';
import { Logger } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { createAuthSchemaPatch, mergeAuthSchema } from './api-document';

const base: OpenAPIObject = {
  openapi: '3.0.0',
  info: { title: 'Board Games Empire API', version: '1.0.0' },
  paths: { '/api/games': { get: { responses: {} } } },
  components: {
    schemas: { Game: { type: 'object' } },
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
  },
};

const auth: OpenAPIObject = {
  openapi: '3.1.1',
  info: { title: 'Better Auth', version: '1.7.25' },
  paths: {
    '/sign-in/email': { post: { responses: {} } },
    '/api/auth/get-session': { get: { responses: {} } },
  },
  components: { schemas: { Session: { type: 'object' } } },
};

/** A `load` that answers from the queue, one entry per call, and counts its calls. */
function loader(...answers: Array<OpenAPIObject | Error>) {
  const load = jest.fn(async () => {
    const answer = answers.shift();
    if (answer === undefined || answer instanceof Error) {
      throw answer ?? new Error('no answer queued');
    }

    return answer;
  });

  return load;
}

describe('mergeAuthSchema (#1511)', () => {
  const merged = mergeAuthSchema(base, auth, 'api');

  it("puts better-auth's paths under the auth mount", () => {
    expect(merged.paths).toHaveProperty(['/api/auth/sign-in/email']);
    expect(merged.paths).not.toHaveProperty(['/sign-in/email']);
  });

  it('keeps a path better-auth already wrote under the mount', () => {
    expect(merged.paths).toHaveProperty(['/api/auth/get-session']);
    expect(merged.paths).not.toHaveProperty(['/api/auth/api/auth/get-session']);
  });

  it("keeps the api's own paths beside better-auth's", () => {
    expect(Object.keys(merged.paths).sort()).toEqual(
      ['/api/auth/get-session', '/api/auth/sign-in/email', '/api/games'].sort(),
    );
  });

  it("merges both documents' schemas and keeps the api's security schemes", () => {
    expect(merged.components?.schemas).toEqual({ Game: { type: 'object' }, Session: { type: 'object' } });
    expect(merged.components?.securitySchemes).toEqual(base.components?.securitySchemes);
  });

  it("keeps the api's document header, not better-auth's", () => {
    expect(merged.openapi).toBe('3.0.0');
    expect(merged.info).toEqual(base.info);
  });

  // As the merge in main.ts always did: better-auth describes its own routes.
  it("takes better-auth's entry where both documents name one path", () => {
    const withAuthRoute: OpenAPIObject = {
      ...base,
      paths: { ...base.paths, '/api/auth/sign-in/email': { get: { responses: {} } } },
    };

    expect(mergeAuthSchema(withAuthRoute, auth, 'api').paths['/api/auth/sign-in/email']).toEqual(
      auth.paths['/sign-in/email'],
    );
  });

  it('changes neither document it is given', () => {
    const baseBefore = structuredClone(base);
    const authBefore = structuredClone(auth);

    mergeAuthSchema(base, auth, 'api');

    expect(base).toEqual(baseBefore);
    expect(auth).toEqual(authBefore);
  });
});

describe('createAuthSchemaPatch (#1511)', () => {
  beforeEach(() => {
    jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('asks better-auth for its schema once and serves the merged document after that', async () => {
    const load = loader(auth);
    const patch = createAuthSchemaPatch(load, 'api');

    const answers = [await patch({}, {}, base), await patch({}, {}, base), await patch({}, {}, base)];

    expect(load).toHaveBeenCalledTimes(1);
    expect(answers[0]).toEqual(mergeAuthSchema(base, auth, 'api'));
    expect(answers[1]).toBe(answers[0]);
    expect(answers[2]).toBe(answers[0]);
  });

  it('shares one request for the schema between two first requests', async () => {
    const load = loader(auth);
    const patch = createAuthSchemaPatch(load, 'api');

    const [first, second] = await Promise.all([patch({}, {}, base), patch({}, {}, base)]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  // A failure is not kept, so the next request for the API document tries
  // again, and the failing request answers a coded 503 rather than hanging.
  it('refuses with a coded 503 when the schema cannot be read, and keeps nothing', async () => {
    const failure = new Error('database unreachable');
    const load = loader(failure, auth);
    const patch = createAuthSchemaPatch(load, 'api');

    const refusal = await patch({}, {}, base).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(CodedHttpException);
    expect(refusal).toMatchObject({
      cause: failure,
      response: {
        statusCode: 503,
        code: 'API_DOCUMENT_UNAVAILABLE',
        message: { message: 'errors.api_document.unavailable' },
      },
    });

    await expect(patch({}, {}, base)).resolves.toEqual(mergeAuthSchema(base, auth, 'api'));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('refuses every request that waited on a failed read, then tries again', async () => {
    const load = loader(new Error('database unreachable'), auth);
    const patch = createAuthSchemaPatch(load, 'api');

    const outcomes = await Promise.allSettled([patch({}, {}, base), patch({}, {}, base)]);

    expect(outcomes.map(({ status }) => status)).toEqual(['rejected', 'rejected']);
    await expect(patch({}, {}, base)).resolves.toBeDefined();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('refuses the same way when the schema it reads cannot be merged', async () => {
    const malformed = { openapi: '3.1.1', info: auth.info } as OpenAPIObject;
    const patch = createAuthSchemaPatch(loader(malformed, auth), 'api');

    await expect(patch({}, {}, base)).rejects.toMatchObject({ response: { code: 'API_DOCUMENT_UNAVAILABLE' } });
    await expect(patch({}, {}, base)).resolves.toBeDefined();
  });

  // Nothing else logs it: the error filter answers an HTTP exception without
  // logging its cause, so this is the operator's only trace of why.
  it('logs why the schema could not be read', async () => {
    const patch = createAuthSchemaPatch(loader(new Error('database unreachable')), 'api');

    await patch({}, {}, base).catch(() => undefined);

    expect(Logger.error).toHaveBeenCalledWith(
      expect.stringContaining('database unreachable'),
      expect.any(String),
      'ApiDocument',
    );
  });
});
