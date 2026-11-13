import { CodedHttpException } from '@bge/i18n';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { RateLimitGuard } from './rate-limit.guard';

const LIMIT = 2;

class GamesController {
  list(): void {
    // A handler the requests are addressed to.
  }
}

/** One request from the same address, with a response that records its headers. */
function requestContext(headers: Map<string, unknown>): ExecutionContext {
  const req = { ip: '203.0.113.7', headers: { 'user-agent': 'test-client' } };
  const res = { header: (name: string, value: unknown) => headers.set(name, value) };

  return {
    getType: () => 'http',
    getClass: () => GamesController,
    getHandler: () => GamesController.prototype.list,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

describe('RateLimitGuard (#527)', () => {
  let storage: ThrottlerStorageService;
  let guard: RateLimitGuard;

  beforeEach(async () => {
    storage = new ThrottlerStorageService();
    guard = new RateLimitGuard(
      { throttlers: [{ name: 'default', ttl: 60_000, limit: LIMIT }] },
      storage,
      new Reflector(),
    );
    await guard.onModuleInit();
  });

  afterEach(() => storage.onApplicationShutdown());

  /** Sends one request more than the limit, and resolves with its refusal and the headers it set. */
  const overTheLimit = async () => {
    for (let sent = 0; sent < LIMIT; sent++) {
      await expect(guard.canActivate(requestContext(new Map()))).resolves.toBe(true);
    }

    const headers = new Map<string, unknown>();
    const refusal = await guard.canActivate(requestContext(headers)).catch((error: unknown) => error);

    return { refusal, headers };
  };

  // The throttler's own refusal is the English string "ThrottlerException:
  // Too Many Requests", which names a class to the client and carries no code
  // (#527, #1260).
  it('refuses the request over the limit with a coded 429 whose copy comes from the catalog (#527)', async () => {
    const { refusal } = await overTheLimit();

    expect(refusal).toBeInstanceOf(CodedHttpException);
    expect(refusal).toMatchObject({
      code: 'RATE_LIMITED',
      response: {
        statusCode: 429,
        error: 'Too Many Requests',
        code: 'RATE_LIMITED',
        message: { key: 'errors.request.rate_limited' },
      },
    });
    expect((refusal as CodedHttpException).getStatus()).toBe(429);
  });

  it('still tells the client when to retry (#527)', async () => {
    const { headers } = await overTheLimit();

    expect(headers.get('Retry-After')).toEqual(expect.any(Number));
  });
});
