import { Logger } from '@nestjs/common';
import { Http } from '@status/codes';
import { MockAgent, type Dispatcher, type Interceptable } from 'undici';
import type { DnsResolver, ResolvedAddress } from './dns/dns-resolver.interface';
import { DnsResolutionError } from './dns/dns-resolver.interface';
import {
  InvalidRequestUrlError,
  OutboundNetworkError,
  RedirectLimitExceededError,
  RedirectToDisallowedTargetError,
  RequestTimeoutError,
  SsrfRejectionError,
} from './errors';
import type { HttpDispatcherFactory } from './http-dispatcher.factory';
import type { OutboundHttpObserver } from './interfaces/outbound-http-observer.interface';
import type { SafeHttpPolicySnapshot } from './interfaces/safe-http-policy-snapshot.interface';
import { IpPolicyService } from './ip/ip-policy.service';
import { NoopOutboundHttpObserver } from './noop-outbound-http.observer';
import type { SafeHttpPolicyService } from './policy/safe-http-policy.service';
import { SecureHttpService } from './secure-http.service';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function buildSnapshot(overrides: Partial<SafeHttpPolicySnapshot> = {}): SafeHttpPolicySnapshot {
  return {
    defaultTimeoutMs: 5_000,
    defaultMaxRedirects: 5,
    strictMode: true,
    allowedHosts: [],
    allowedCidrs: [],
    blockedHosts: [],
    blockedCidrs: [],
    ...overrides,
  };
}

class StubPolicyService {
  constructor(public snapshot: SafeHttpPolicySnapshot = buildSnapshot()) {}
  current(): SafeHttpPolicySnapshot {
    return this.snapshot;
  }
}

class FakeDnsResolver implements DnsResolver {
  readonly responses = new Map<string, ResolvedAddress[]>();

  set(hostname: string, addresses: ResolvedAddress[]): void {
    this.responses.set(hostname, addresses);
  }

  async resolveAll(hostname: string): Promise<ResolvedAddress[]> {
    const entry = this.responses.get(hostname);
    if (!entry) throw new DnsResolutionError(hostname, new Error('NXDOMAIN'));
    return entry;
  }
}

/**
 * Test factory that returns the supplied MockAgent for every `build()` call.
 * MockAgent itself is a Dispatcher and supports per-origin / per-path
 * interception with `intercept().reply()`. Pin-IP behavior is irrelevant in
 * this layer of tests — the IP policy service is tested separately.
 */
class FakeDispatcherFactory implements HttpDispatcherFactory {
  constructor(private readonly agent: Dispatcher) {}

  build(): Dispatcher {
    return new Proxy(this.agent, {
      get(target, prop) {
        if (prop === 'close' || prop === 'destroy') {
          return async () => undefined;
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
}

// ─── Wire-up ────────────────────────────────────────────────────────────────

function buildService(opts: {
  snapshot?: SafeHttpPolicySnapshot;
  dns?: FakeDnsResolver;
  mockAgent: MockAgent;
  observer?: OutboundHttpObserver;
}): { service: SecureHttpService; pool: Interceptable } {
  const dns = opts.dns ?? new FakeDnsResolver();
  const policy = new StubPolicyService(opts.snapshot ?? buildSnapshot());
  const ipPolicy = new IpPolicyService(dns);
  const factory = new FakeDispatcherFactory(opts.mockAgent);
  const observer = opts.observer ?? new NoopOutboundHttpObserver();

  const service = new SecureHttpService(policy as unknown as SafeHttpPolicyService, ipPolicy, factory, observer);

  // Suppress Nest's logger during tests so observer-warning paths don't spam.
  jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  jest.spyOn(Logger.prototype, 'error').mockImplementation();

  return { service, pool: opts.mockAgent.get('http://example.com') };
}

const v4 = (address: string): ResolvedAddress => ({ address, family: 4 });

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('SecureHttpService', () => {
  let mockAgent: MockAgent;

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
  });

  afterEach(async () => {
    await mockAgent.close();
    jest.restoreAllMocks();
  });

  describe('happy path', () => {
    it('returns a parsed JSON response for a Http.Ok', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('8.8.8.8')]);
      const { service, pool } = buildService({ dns, mockAgent });
      pool.intercept({ path: '/data', method: 'GET' }).reply(Http.Ok, { ok: true });

      const response = await service.request<{ ok: boolean }>('http://example.com/data');

      expect(response.status).toBe(Http.Ok);
      expect(response.body).toEqual({ ok: true });
      expect(response.redirectCount).toBe(0);
      expect(response.finalUrl).toBe('http://example.com/data');
    });

    it('returns raw payload always, even when JSON parsing fails', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('8.8.8.8')]);
      const { service, pool } = buildService({ dns, mockAgent });
      pool.intercept({ path: '/html' }).reply(Http.Ok, '<html>not json</html>', {
        headers: { 'content-type': 'text/html' },
      });

      const response = await service.request('http://example.com/html');

      expect(response.body).toBeNull();
      expect(response.raw).toContain('<html>');
    });

    it('returns parsed text for responseType: text', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('8.8.8.8')]);
      const { service, pool } = buildService({ dns, mockAgent });
      pool.intercept({ path: '/t' }).reply(Http.Ok, 'hello world');

      const response = await service.request<string>('http://example.com/t', { responseType: 'text' });

      expect(response.body).toBe('hello world');
    });

    it('returns ArrayBuffer for responseType: arraybuffer', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('8.8.8.8')]);
      const { service, pool } = buildService({ dns, mockAgent });
      pool.intercept({ path: '/bin' }).reply(Http.Ok, Buffer.from([1, 2, 3]));

      const response = await service.request<ArrayBuffer>('http://example.com/bin', { responseType: 'arraybuffer' });

      expect(response.body).toBeInstanceOf(ArrayBuffer);
      const view = new Uint8Array(response.body as ArrayBuffer);
      expect(Array.from(view)).toEqual([1, 2, 3]);
    });

    it('JSON-encodes object bodies and sets content-type', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('8.8.8.8')]);
      const { service, pool } = buildService({ dns, mockAgent });
      let capturedBody: string | undefined;
      let capturedContentType: string | undefined;

      pool.intercept({ path: '/post', method: 'POST' }).reply(Http.Ok, (opts) => {
        capturedBody = opts.body?.toString();
        capturedContentType = (opts.headers as Record<string, string> | undefined)?.['content-type'];
        return { ok: true };
      });

      await service.request('http://example.com/post', {
        method: 'POST',
        body: { hello: 'world' },
      });

      expect(capturedBody).toBe('{"hello":"world"}');
      expect(capturedContentType).toBe('application/json');
    });

    it('returns non-2xx statuses without throwing', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('8.8.8.8')]);
      const { service, pool } = buildService({ dns, mockAgent });
      pool.intercept({ path: '/notfound' }).reply(404, { error: 'gone' });

      const response = await service.request('http://example.com/notfound');
      expect(response.status).toBe(404);
    });
  });

  describe('SSRF rejection', () => {
    it('throws SsrfRejectionError when the initial URL fails the gauntlet', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('127.0.0.1')]);
      const { service } = buildService({ dns, mockAgent });

      await expect(service.request('http://example.com/')).rejects.toBeInstanceOf(SsrfRejectionError);
    });

    it('does NOT retry SSRF rejections even when retry is configured', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('127.0.0.1')]);
      const { service } = buildService({ dns, mockAgent });
      const resolveSpy = jest.spyOn(dns, 'resolveAll');

      await expect(
        service.request('http://example.com/', {
          retry: { attempts: 3, baseDelayMs: 1, jitter: false },
        }),
      ).rejects.toBeInstanceOf(SsrfRejectionError);

      expect(resolveSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('redirects', () => {
    it('follows a 302 Location and re-runs the SSRF gauntlet on the hop', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('8.8.8.8')]);
      dns.set('elsewhere.com', [v4('1.1.1.1')]);

      mockAgent
        .get('http://example.com')
        .intercept({ path: '/redirect' })
        .reply(Http.Found, '', { headers: { location: 'http://elsewhere.com/final' } });
      mockAgent.get('http://elsewhere.com').intercept({ path: '/final' }).reply(Http.Ok, { ok: true });

      const { service } = buildService({ dns, mockAgent });
      const response = await service.request('http://example.com/redirect');

      expect(response.status).toBe(Http.Ok);
      expect(response.redirectCount).toBe(1);
      expect(response.finalUrl).toBe('http://elsewhere.com/final');
    });

    it('throws RedirectToDisallowedTargetError when a redirect lands on a private IP', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('8.8.8.8')]);
      dns.set('internal.com', [v4('127.0.0.1')]);

      mockAgent
        .get('http://example.com')
        .intercept({ path: '/redirect' })
        .reply(Http.Found, '', { headers: { location: 'http://internal.com/admin' } });

      const { service } = buildService({ dns, mockAgent });
      await expect(service.request('http://example.com/redirect')).rejects.toBeInstanceOf(
        RedirectToDisallowedTargetError,
      );
    });

    it('throws RedirectLimitExceededError when chain exceeds maxRedirects', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('8.8.8.8')]);

      const pool = mockAgent.get('http://example.com');
      // Three hops in a chain, but maxRedirects=2 → throws on the 3rd.
      pool.intercept({ path: '/a' }).reply(Http.Found, '', { headers: { location: 'http://example.com/b' } });
      pool.intercept({ path: '/b' }).reply(Http.Found, '', { headers: { location: 'http://example.com/c' } });
      pool.intercept({ path: '/c' }).reply(Http.Found, '', { headers: { location: 'http://example.com/d' } });

      const { service } = buildService({ dns, mockAgent });
      await expect(service.request('http://example.com/a', { maxRedirects: 2 })).rejects.toBeInstanceOf(
        RedirectLimitExceededError,
      );
    });

    it('Http.SeeOther redirects convert POST to GET and drop body', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('8.8.8.8')]);

      let secondMethod: string | undefined;
      let secondBody: string | undefined;

      mockAgent
        .get('http://example.com')
        .intercept({ path: '/post', method: 'POST' })
        .reply(Http.SeeOther, '', { headers: { location: 'http://example.com/result' } });
      mockAgent
        .get('http://example.com')
        .intercept({ path: '/result' })
        .reply(Http.Ok, (opts) => {
          secondMethod = opts.method;
          secondBody = opts.body?.toString();
          return { ok: true };
        });

      const { service } = buildService({ dns, mockAgent });
      await service.request('http://example.com/post', {
        method: 'POST',
        body: { drop: 'me' },
      });

      expect(secondMethod).toBe('GET');
      expect(secondBody).toBeFalsy();
    });
  });

  describe('retry', () => {
    it('retries on 503 until exhaustion', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('8.8.8.8')]);

      const pool = mockAgent.get('http://example.com');
      pool.intercept({ path: '/flaky' }).reply(Http.ServiceUnavailable, 'down').times(3);

      const { service } = buildService({ dns, mockAgent });
      const response = await service.request('http://example.com/flaky', {
        retry: { attempts: 3, baseDelayMs: 1, jitter: false },
      });

      // After 3 attempts, returns the final Http.ServiceUnavailable response — not an exception.
      expect(response.status).toBe(Http.ServiceUnavailable);
    });

    it('stops retrying once a 2xx is observed', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('8.8.8.8')]);

      const pool = mockAgent.get('http://example.com');
      pool.intercept({ path: '/recovery' }).reply(Http.ServiceUnavailable, 'down').times(1);
      pool.intercept({ path: '/recovery' }).reply(Http.Ok, { ok: true });

      const { service } = buildService({ dns, mockAgent });
      const response = await service.request('http://example.com/recovery', {
        retry: { attempts: 5, baseDelayMs: 1, jitter: false },
      });

      expect(response.status).toBe(Http.Ok);
    });

    it('does not retry non-listed status codes', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('8.8.8.8')]);

      mockAgent.get('http://example.com').intercept({ path: '/four' }).reply(Http.BadRequest, 'bad');

      const { service } = buildService({ dns, mockAgent });
      const response = await service.request('http://example.com/four', {
        retry: { attempts: 3, baseDelayMs: 1, jitter: false },
      });

      expect(response.status).toBe(Http.BadRequest);
      // Pending interceptors would error on close() if we under-consumed —
      // exactly one match is what we expect.
      expect(mockAgent.pendingInterceptors().filter((i) => i.path === '/four')).toHaveLength(0);
    });
  });

  describe('observer notifications', () => {
    it('fires onRequest, onResponse on success', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('8.8.8.8')]);

      const observer: jest.Mocked<OutboundHttpObserver> = {
        onRequest: jest.fn(),
        onResponse: jest.fn(),
        onError: jest.fn(),
        onSsrfRejection: jest.fn(),
        onRedirectDenied: jest.fn(),
      };

      const { service } = buildService({ dns, mockAgent, observer });
      mockAgent.get('http://example.com').intercept({ path: '/' }).reply(Http.Ok, {});

      await service.request('http://example.com/');

      expect(observer.onRequest).toHaveBeenCalledTimes(1);
      expect(observer.onResponse).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'http://example.com/', method: 'GET', status: Http.Ok }),
      );
      expect(observer.onSsrfRejection).not.toHaveBeenCalled();
    });

    it('fires onSsrfRejection on initial URL SSRF failure', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('127.0.0.1')]);

      const observer: jest.Mocked<OutboundHttpObserver> = {
        onRequest: jest.fn(),
        onResponse: jest.fn(),
        onError: jest.fn(),
        onSsrfRejection: jest.fn(),
        onRedirectDenied: jest.fn(),
      };

      const { service } = buildService({ dns, mockAgent, observer });
      await expect(service.request('http://example.com/')).rejects.toBeDefined();

      expect(observer.onSsrfRejection).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'example.com', reason: 'private-range' }),
      );
    });

    it('fires onRedirectDenied on redirect-hop SSRF failure', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('8.8.8.8')]);
      dns.set('internal.com', [v4('127.0.0.1')]);

      mockAgent
        .get('http://example.com')
        .intercept({ path: '/redirect' })
        .reply(302, '', { headers: { location: 'http://internal.com/admin' } });

      const observer: jest.Mocked<OutboundHttpObserver> = {
        onRequest: jest.fn(),
        onResponse: jest.fn(),
        onError: jest.fn(),
        onSsrfRejection: jest.fn(),
        onRedirectDenied: jest.fn(),
      };

      const { service } = buildService({ dns, mockAgent, observer });
      await expect(service.request('http://example.com/redirect')).rejects.toBeDefined();

      expect(observer.onRedirectDenied).toHaveBeenCalledWith(expect.objectContaining({ reason: 'private-range' }));
    });

    it('isolates observer exceptions from the caller', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('8.8.8.8')]);

      const observer: OutboundHttpObserver = {
        onRequest: () => {
          throw new Error('observer is broken');
        },
      };

      const { service } = buildService({ dns, mockAgent, observer });
      mockAgent.get('http://example.com').intercept({ path: '/' }).reply(Http.Ok, {});

      // Caller never sees the observer error.
      await expect(service.request('http://example.com/')).resolves.toMatchObject({ status: Http.Ok });
    });
  });

  describe('error mapping', () => {
    it('wraps a generic network error as OutboundNetworkError', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('8.8.8.8')]);

      mockAgent.get('http://example.com').intercept({ path: '/' }).replyWithError(new Error('connection reset'));

      const { service } = buildService({ dns, mockAgent });
      await expect(service.request('http://example.com/')).rejects.toBeInstanceOf(OutboundNetworkError);
    });
  });

  describe('timeout', () => {
    // Note: testing real timeout via MockAgent requires its delay() support;
    // we verify the error class binding rather than wall-clock behavior.
    it('throws RequestTimeoutError when the timeout signal fires', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('8.8.8.8')]);

      // Delay response 500ms; timeout is 10ms.
      mockAgent.get('http://example.com').intercept({ path: '/slow' }).reply(Http.Ok, {}).delay(500);

      const { service } = buildService({ dns, mockAgent });
      await expect(service.request('http://example.com/slow', { timeoutMs: 10 })).rejects.toBeInstanceOf(
        RequestTimeoutError,
      );
    });
  });

  describe('scheme rejection', () => {
    it.each(['ftp://example.com/', 'file:///etc/passwd', 'gopher://example.com/'])(
      'throws InvalidRequestUrlError (not SsrfRejectionError) for %s',
      async (url) => {
        const { service } = buildService({ dns: new FakeDnsResolver(), mockAgent });
        await expect(service.request(url)).rejects.toBeInstanceOf(InvalidRequestUrlError);
      },
    );
  });
});
