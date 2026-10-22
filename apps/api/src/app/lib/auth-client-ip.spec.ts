import { AUTH_CLIENT_IP_HEADER } from '@bge/auth';
import { Logger } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAuthClientIpHandler } from './auth-client-ip';

/** A request stand-in carrying what the handler reads and writes. */
function request(options: { peer?: string; headers?: Record<string, string> } = {}) {
  return {
    headers: { ...options.headers },
    socket: { remoteAddress: options.peer ?? '203.0.113.7' },
  } as unknown as IncomingMessage;
}

/** Runs the handler and returns its `next`, which it must call to pass the request on to better-auth. */
function run(handler: ReturnType<typeof createAuthClientIpHandler>, req: IncomingMessage) {
  const next = jest.fn();
  handler(req, {} as ServerResponse, next);
  return next;
}

/**
 * better-auth's rate limiter keys each client on the header this handler
 * writes, so the property under test is the one #340 pinned for the Nest
 * throttler: a client cannot choose their own bucket. Which address the rule
 * picks is `ip-tracker.spec.ts`'s to pin; these show the handler applies it.
 */
describe('createAuthClientIpHandler (#640)', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('tells better-auth the peer address when nothing is in front, and passes the request on (#640)', () => {
    const req = request({ peer: '198.51.100.4' });

    const next = run(createAuthClientIpHandler(0), req);

    expect(req.headers[AUTH_CLIENT_IP_HEADER]).toBe('198.51.100.4');
    expect(next).toHaveBeenCalledWith();
  });

  it('replaces an address the client sent in the header itself (#640)', () => {
    const req = request({ peer: '198.51.100.4', headers: { [AUTH_CLIENT_IP_HEADER]: '192.0.2.1' } });

    run(createAuthClientIpHandler(0), req);

    expect(req.headers[AUTH_CLIENT_IP_HEADER]).toBe('198.51.100.4');
  });

  it('applies the configured hop count: behind one proxy, the address it recorded (#640)', () => {
    const req = request({ peer: '10.0.0.9', headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.4' } });

    run(createAuthClientIpHandler(1), req);

    expect(req.headers[AUTH_CLIENT_IP_HEADER]).toBe('198.51.100.4');
  });
});
