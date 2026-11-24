import type { Actor, AuditContextService } from '@bge/actor-context';
import { RiskLevel } from '@bge/database';
import { isI18nMessage } from '@bge/i18n';
import { CHECK_POLICIES_KEY } from '@bge/permissions';
import { boundPageQuery } from '@bge/testing';
import { HttpException } from '@nestjs/common';
import { Http } from '@status/codes';
import 'reflect-metadata';
import type { Observable } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import { ApiKeyController } from './api-key.controller';
import type { ApiKeyService, ApiKeyView, CurrentApiKeyView } from './api-key.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { ListApiKeysQueryDto } from './dto/list-api-keys.query.dto';
import { UpdateApiKeyDto } from './dto/update-api-key.dto';

const USER_ID = 'user-1';
const KEY_ID = 'key-1';

const SESSION: Actor = { kind: 'user', userId: USER_ID };
const API_KEY: Actor = { kind: 'apiKey', apiKeyId: KEY_ID, userId: USER_ID };

const VIEW: ApiKeyView = {
  id: KEY_ID,
  name: 'Home Assistant',
  start: 'bge_ab',
  scopes: [{ slug: 'read:game', resourceId: null }],
  expiresAt: new Date('2027-02-21T00:00:00Z'),
  enabled: true,
  lastUsedAt: null,
  createdAt: new Date('2026-11-23T00:00:00Z'),
};

/** The error a call throws, synchronously or from its observable. */
async function thrownBy(call: () => Observable<unknown>): Promise<unknown> {
  try {
    await firstValueFrom(call());
  } catch (error) {
    return error;
  }

  return undefined;
}

/** The status and code of a coded refusal, so a test names both. */
function refusal(error: unknown): { code?: unknown; status?: number } {
  if (!(error instanceof HttpException)) {
    return {};
  }

  const body = error.getResponse();

  return { status: error.getStatus(), code: typeof body === 'object' && 'code' in body ? body.code : undefined };
}

function dto<T extends object>(type: new () => T, plain: Partial<T>): T {
  return Object.assign(new type(), plain);
}

describe('ApiKeyController (#1417, #1418)', () => {
  let service: jest.Mocked<
    Pick<ApiKeyService, 'create' | 'current' | 'get' | 'grantableFor' | 'list' | 'remove' | 'update'>
  >;
  let auditContext: jest.Mocked<Pick<AuditContextService, 'getActor'>>;
  let controller: ApiKeyController;

  beforeEach(() => {
    service = {
      grantableFor: jest.fn().mockResolvedValue([
        {
          id: 'perm-manage-safe-http-policy',
          slug: 'manage:safe_http_policy',
          riskLevel: RiskLevel.Critical,
          pinnable: false,
        },
        { id: 'perm-read-ban', slug: 'read:household_ban', riskLevel: RiskLevel.Low, pinnable: true },
      ]),
      create: jest.fn().mockResolvedValue({ apiKey: VIEW, secret: 'bge_secret' }),
      list: jest.fn().mockResolvedValue({ rows: [VIEW], total: 1 }),
      get: jest.fn().mockResolvedValue(VIEW),
      update: jest.fn().mockResolvedValue(VIEW),
      remove: jest.fn().mockResolvedValue(undefined),
      current: jest.fn().mockResolvedValue({ ...VIEW, secondsRemaining: 60 } satisfies CurrentApiKeyView),
    };
    auditContext = { getActor: jest.fn().mockReturnValue(SESSION) };
    controller = new ApiKeyController(
      service as unknown as ApiKeyService,
      auditContext as unknown as AuditContextService,
    );
  });

  describe('GET /api/api-keys/grantable', () => {
    it('maps each entry to slug, description marker, riskLevel and pinnable', async () => {
      const { permissions } = await firstValueFrom(controller.grantable());

      expect(service.grantableFor).toHaveBeenCalledWith(USER_ID);
      expect(permissions).toEqual([
        {
          slug: 'manage:safe_http_policy',
          description: expect.objectContaining({ key: 'permissions.manage:safe_http_policy' }),
          riskLevel: RiskLevel.Critical,
          pinnable: false,
        },
        {
          slug: 'read:household_ban',
          description: expect.objectContaining({ key: 'permissions.read:household_ban' }),
          riskLevel: RiskLevel.Low,
          pinnable: true,
        },
      ]);
      expect(permissions.every(({ description }) => isI18nMessage(description))).toBe(true);
      // The response interceptor renders markers inside plain objects only, so
      // each entry must be one, not a class instance.
      expect(permissions.every((entry) => Object.getPrototypeOf(entry) === Object.prototype)).toBe(true);
    });

    // An anonymous user holds no account of their own to hand a key, so only a
    // registered user signed in as themself reads the list (#1417). The refusal
    // carries a code a client can announce (#1418).
    it("refuses an anonymous user's actor with 403 API_KEY_SESSION_REQUIRED", async () => {
      auditContext.getActor.mockReturnValue({ kind: 'anonymous', userId: USER_ID });

      expect(refusal(await thrownBy(() => controller.grantable()))).toEqual({
        status: Http.Forbidden,
        code: 'API_KEY_SESSION_REQUIRED',
      });
      expect(service.grantableFor).not.toHaveBeenCalled();
    });

    // Every signed-in user may list their own, so no policy gates the route.
    it('carries no policy check', () => {
      expect(Reflect.getMetadata(CHECK_POLICIES_KEY, ApiKeyController.prototype.grantable)).toBeUndefined();
    });
  });

  // A key acts for its owner but is not the owner: a leaked key must not read
  // what its owner may hand a key, or mint, list, edit or delete keys (#1418).
  describe.each([
    ['GET /grantable', (c: ApiKeyController) => c.grantable()],
    ['POST /', (c: ApiKeyController) => c.create(dto(CreateApiKeyDto, { name: 'Wider key' }))],
    ['GET /', (c: ApiKeyController) => c.list(boundPageQuery(ListApiKeysQueryDto))],
    ['GET /:id', (c: ApiKeyController) => c.get(KEY_ID)],
    ['PATCH /:id', (c: ApiKeyController) => c.update(KEY_ID, dto(UpdateApiKeyDto, { enabled: false }))],
    ['DELETE /:id', (c: ApiKeyController) => c.remove(KEY_ID)],
  ])('%s called by an API key (#1418)', (_route, call: (c: ApiKeyController) => Observable<unknown>) => {
    it('answers 403 API_KEY_SESSION_REQUIRED and reaches no service', async () => {
      auditContext.getActor.mockReturnValue(API_KEY);

      expect(refusal(await thrownBy(() => call(controller)))).toEqual({
        status: Http.Forbidden,
        code: 'API_KEY_SESSION_REQUIRED',
      });
      Object.values(service).forEach((method) => expect(method).not.toHaveBeenCalled());
    });
  });

  describe('GET /api/api-keys/current (#1418)', () => {
    it("answers the calling key, read by the key's own id", async () => {
      auditContext.getActor.mockReturnValue(API_KEY);

      const body = await firstValueFrom(controller.current());

      expect(service.current).toHaveBeenCalledWith(KEY_ID);
      expect(body).toEqual({ apiKey: { ...VIEW, secondsRemaining: 60 } });
    });

    // The route describes the calling key, so a session has no key to describe.
    it('answers a session 403 API_KEY_REQUIRED', async () => {
      expect(refusal(await thrownBy(() => controller.current()))).toEqual({
        status: Http.Forbidden,
        code: 'API_KEY_REQUIRED',
      });
      expect(service.current).not.toHaveBeenCalled();
    });

    it('answers a missing actor 403 API_KEY_REQUIRED', async () => {
      auditContext.getActor.mockReturnValue(null);

      expect(refusal(await thrownBy(() => controller.current()))).toEqual({
        status: Http.Forbidden,
        code: 'API_KEY_REQUIRED',
      });
    });
  });

  describe('POST /api/api-keys (#1418)', () => {
    it("creates the key for the session's user and answers its secret", async () => {
      const body = dto(CreateApiKeyDto, {
        name: 'Home Assistant',
        scopes: [{ slug: 'read:game' }],
        expiresInDays: 30,
        confirmCritical: true,
      });

      const answer = await firstValueFrom(controller.create(body));

      expect(service.create).toHaveBeenCalledWith(USER_ID, body);
      expect(answer).toEqual({
        message: expect.objectContaining({ key: 'success.api_key.created' }),
        apiKey: VIEW,
        secret: 'bge_secret',
      });
      expect(isI18nMessage(answer.message)).toBe(true);
    });
  });

  describe('GET /api/api-keys (#1418)', () => {
    it("pages the session user's keys under apiKeys", async () => {
      const query = boundPageQuery(ListApiKeysQueryDto, { page: 2, limit: 5 });
      service.list.mockResolvedValue({ rows: [VIEW], total: 6 });

      const answer = await firstValueFrom(controller.list(query));

      expect(service.list).toHaveBeenCalledWith(USER_ID, query);
      expect(answer).toEqual({
        apiKeys: [VIEW],
        pagination: { page: 2, limit: 5, total: 6, totalPages: 2, hasMore: false },
      });
    });
  });

  describe('GET /api/api-keys/:id (#1418)', () => {
    it("reads the session user's key", async () => {
      const answer = await firstValueFrom(controller.get(KEY_ID));

      expect(service.get).toHaveBeenCalledWith(USER_ID, KEY_ID);
      expect(answer).toEqual({ apiKey: VIEW });
    });
  });

  describe('PATCH /api/api-keys/:id (#1418)', () => {
    it("edits the session user's key and answers it", async () => {
      const body = dto(UpdateApiKeyDto, { name: 'Renamed', enabled: false });

      const answer = await firstValueFrom(controller.update(KEY_ID, body));

      expect(service.update).toHaveBeenCalledWith(USER_ID, KEY_ID, body);
      expect(answer).toEqual({ message: expect.objectContaining({ key: 'success.api_key.updated' }), apiKey: VIEW });
    });
  });

  describe('DELETE /api/api-keys/:id (#1418)', () => {
    it("deletes the session user's key", async () => {
      const answer = await firstValueFrom(controller.remove(KEY_ID));

      expect(service.remove).toHaveBeenCalledWith(USER_ID, KEY_ID);
      expect(answer).toEqual({ message: expect.objectContaining({ key: 'success.api_key.deleted' }) });
    });
  });

  // `/current` and `/grantable` are declared before `/:id`, or Express would
  // hand them to `get` as an id (#1418).
  it('declares the fixed routes before the :id routes', () => {
    const names = Object.getOwnPropertyNames(ApiKeyController.prototype);

    expect(names.indexOf('grantable')).toBeLessThan(names.indexOf('get'));
    expect(names.indexOf('current')).toBeLessThan(names.indexOf('get'));
  });
});
