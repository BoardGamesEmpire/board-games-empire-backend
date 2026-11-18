import { Logger } from '@nestjs/common';
import { Http } from '@status/codes';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, MockAgent, type Dispatcher, type Interceptable } from 'undici';
import type { DnsResolver, ResolvedAddress } from './dns/dns-resolver.interface';
import { DnsResolutionError } from './dns/dns-resolver.interface';
import {
  HostNotAllowedError,
  InvalidRequestUrlError,
  OutboundNetworkError,
  RedirectLimitExceededError,
  RedirectToDisallowedTargetError,
  RequestTimeoutError,
  ResponseTooLargeError,
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
    if (!entry) {
      throw new DnsResolutionError(hostname, new Error('NXDOMAIN'));
    }
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

    // NaN or Infinity never meets `redirectCount >= maxRedirects`, so a
    // redirect loop would run on until the time limit. A cap that is not a
    // count is a caller's bug, refused before any request (#1094).
    it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
      'refuses a maxRedirects of %p before any request (#1094)',
      async (maxRedirects) => {
        const dns = new FakeDnsResolver();
        dns.set('example.com', [v4('8.8.8.8')]);
        const onRequest = jest.fn();
        const { service } = buildService({ dns, mockAgent, observer: { onRequest } });

        await expect(service.request('http://example.com/a', { maxRedirects })).rejects.toBeInstanceOf(RangeError);
        expect(onRequest).not.toHaveBeenCalled();
      },
    );

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

    // A caller held to named hosts (a plugin, to its plugin manifest's outbound
    // domains) can't check a redirect's target before the request, because
    // this service follows redirects itself. So the rule is asked on every
    // hop, ahead of the outbound HTTP policy's address lookup (#1083).
    describe('a caller host rule (#1083)', () => {
      it("refuses a first URL the caller's host rule rejects, before any lookup (#1083)", async () => {
        const dns = new FakeDnsResolver();
        dns.set('example.com', [v4('8.8.8.8')]);
        const evaluate = jest.spyOn(IpPolicyService.prototype, 'evaluate');
        const build = jest.spyOn(FakeDispatcherFactory.prototype, 'build');
        const { service } = buildService({ dns, mockAgent });

        const refusal = service.request('http://example.com/data', { allowHost: () => false });

        await expect(refusal).rejects.toBeInstanceOf(HostNotAllowedError);
        await expect(refusal).rejects.toMatchObject({ code: 'OUTBOUND_HOST_NOT_ALLOWED', host: 'example.com' });
        expect(evaluate).not.toHaveBeenCalled();
        expect(build).not.toHaveBeenCalled();
      });

      it('refuses a redirect to a host the rule rejects (#1083)', async () => {
        const dns = new FakeDnsResolver();
        dns.set('example.com', [v4('8.8.8.8')]);
        dns.set('elsewhere.com', [v4('1.1.1.1')]);
        mockAgent
          .get('http://example.com')
          .intercept({ path: '/redirect' })
          .reply(Http.Found, '', { headers: { location: 'http://elsewhere.com/final' } });
        const onRedirectDenied = jest.fn();
        const build = jest.spyOn(FakeDispatcherFactory.prototype, 'build');
        const { service } = buildService({ dns, mockAgent, observer: { onRedirectDenied } });

        const refusal = service.request('http://example.com/redirect', {
          allowHost: (hostname) => hostname === 'example.com',
        });

        await expect(refusal).rejects.toBeInstanceOf(RedirectToDisallowedTargetError);
        const err = (await refusal.catch((e: unknown) => e)) as RedirectToDisallowedTargetError;
        expect(err.cause).toBeInstanceOf(HostNotAllowedError);
        expect(err.cause).toMatchObject({ host: 'elsewhere.com' });
        expect(build).toHaveBeenCalledTimes(1);
        expect(onRedirectDenied).toHaveBeenCalledWith({
          from: 'http://example.com/redirect',
          to: 'http://elsewhere.com/final',
          reason: 'host-not-allowed',
        });
      });

      it("asks the rule once per hop, with each hop's hostname (#1083)", async () => {
        const dns = new FakeDnsResolver();
        dns.set('example.com', [v4('8.8.8.8')]);
        dns.set('elsewhere.com', [v4('1.1.1.1')]);
        mockAgent
          .get('http://example.com')
          .intercept({ path: '/redirect' })
          .reply(Http.Found, '', { headers: { location: 'http://elsewhere.com/final' } });
        mockAgent.get('http://elsewhere.com').intercept({ path: '/final' }).reply(Http.Ok, { ok: true });
        const allowHost = jest.fn(() => true);
        const { service } = buildService({ dns, mockAgent });

        const response = await service.request('http://example.com/redirect', { allowHost });

        expect(response.status).toBe(Http.Ok);
        expect(allowHost.mock.calls).toEqual([['example.com'], ['elsewhere.com']]);
      });

      // A caller's rule names hosts, not ports: a plugin manifest can't
      // declare a port, so a declared host must pass on whichever port the
      // URL names (#1083).
      it('asks the rule with the hostname, without the port (#1083)', async () => {
        const dns = new FakeDnsResolver();
        dns.set('example.com', [v4('8.8.8.8')]);
        mockAgent.get('http://example.com:8080').intercept({ path: '/data' }).reply(Http.Ok, { ok: true });
        const allowHost = jest.fn((hostname: string) => hostname === 'example.com');
        const { service } = buildService({ dns, mockAgent });

        const response = await service.request('http://example.com:8080/data', { allowHost });

        expect(response.status).toBe(Http.Ok);
        expect(allowHost.mock.calls).toEqual([['example.com']]);
      });

      it('never retries a host refusal (#1083)', async () => {
        const dns = new FakeDnsResolver();
        dns.set('example.com', [v4('8.8.8.8')]);
        const allowHost = jest.fn(() => false);
        const { service } = buildService({ dns, mockAgent });

        await expect(
          service.request('http://example.com/data', {
            allowHost,
            retry: { attempts: 3, baseDelayMs: 1, jitter: false },
          }),
        ).rejects.toBeInstanceOf(HostNotAllowedError);

        expect(allowHost).toHaveBeenCalledTimes(1);
      });

      it('without a rule, behaves as before (#1083)', async () => {
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
        expect(response.finalUrl).toBe('http://elsewhere.com/final');
      });
    });

    // The caller's headers ride along on every hop. A credential among them
    // is meant for the origin the caller named, so a redirect that leaves
    // that origin (another host, another port, or https down to http) goes
    // on without it, as fetch does. A plugin's declared hosts are checked by
    // name only, so without this its key would follow a redirect onto http
    // or onto another declared host (#1083).
    describe("the caller's credentials on a redirect (#1083)", () => {
      const sent = {
        Authorization: 'Bearer KEY',
        Cookie: 'session=1',
        'Proxy-Authorization': 'Basic cHJveHk=',
        'x-trace': 't-1',
      };

      /** Follows one redirect from `from` to `to` and returns the headers the second hop carried. */
      const headersAfterRedirect = async (from: string, to: string): Promise<Record<string, string>> => {
        const dns = new FakeDnsResolver();
        dns.set('example.com', [v4('8.8.8.8')]);
        dns.set('elsewhere.com', [v4('1.1.1.1')]);
        const first = new URL(from);
        const second = new URL(to);
        let seen: Record<string, string> = {};
        mockAgent
          .get(first.origin)
          .intercept({ path: first.pathname })
          .reply(Http.Found, '', { headers: { location: to } });
        mockAgent
          .get(second.origin)
          .intercept({ path: second.pathname })
          .reply(Http.Ok, (opts) => {
            seen = opts.headers as Record<string, string>;
            return { ok: true };
          });
        const { service } = buildService({ dns, mockAgent });

        const response = await service.request(from, { headers: sent });

        expect(response.redirectCount).toBe(1);
        return seen;
      };

      it.each([
        ['another host', 'https://example.com/a', 'https://elsewhere.com/b'],
        ['http, from https', 'https://example.com/a', 'http://example.com/b'],
        ['another port', 'https://example.com/a', 'https://example.com:8443/b'],
      ])('drops them when the redirect goes to %s (#1083)', async (_label, from, to) => {
        const seen = await headersAfterRedirect(from, to);

        expect(seen).not.toHaveProperty('authorization');
        expect(seen).not.toHaveProperty('cookie');
        expect(seen).not.toHaveProperty('proxy-authorization');
        expect(seen['x-trace']).toBe('t-1');
      });

      it('keeps them when the redirect stays on the same origin (#1083)', async () => {
        const seen = await headersAfterRedirect('https://example.com/a', 'https://example.com/b');

        expect(seen).toMatchObject({
          authorization: 'Bearer KEY',
          cookie: 'session=1',
          'proxy-authorization': 'Basic cHJveHk=',
          'x-trace': 't-1',
        });
      });

      // Once dropped they stay dropped, as in fetch: a later hop back to the
      // first origin was reached through the other one.
      it('does not put them back when a later redirect returns to the first origin (#1083)', async () => {
        const dns = new FakeDnsResolver();
        dns.set('example.com', [v4('8.8.8.8')]);
        dns.set('elsewhere.com', [v4('1.1.1.1')]);
        let seen: Record<string, string> = {};
        mockAgent
          .get('https://example.com')
          .intercept({ path: '/a' })
          .reply(Http.Found, '', { headers: { location: 'https://elsewhere.com/b' } });
        mockAgent
          .get('https://elsewhere.com')
          .intercept({ path: '/b' })
          .reply(Http.Found, '', { headers: { location: 'https://example.com/c' } });
        mockAgent
          .get('https://example.com')
          .intercept({ path: '/c' })
          .reply(Http.Ok, (opts) => {
            seen = opts.headers as Record<string, string>;
            return { ok: true };
          });
        const { service } = buildService({ dns, mockAgent });

        await service.request('https://example.com/a', { headers: sent });

        expect(seen).not.toHaveProperty('authorization');
        expect(seen['x-trace']).toBe('t-1');
      });
    });
  });

  // RFC 9110 lets a recipient join a repeated header's values with a comma,
  // except Set-Cookie: a cookie's Expires date holds a comma, so the joined
  // value can't be split again. The plugin HTTP client rebuilds a Response
  // from this answer and needs each cookie by itself (#1083).
  describe('Set-Cookie', () => {
    it('hands back each Set-Cookie header by itself (#1083)', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('8.8.8.8')]);
      const { service, pool } = buildService({ dns, mockAgent });
      const cookies = ['a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT', 'b=2'];
      pool.intercept({ path: '/login' }).reply(Http.Ok, { ok: true }, { headers: { 'set-cookie': cookies } });

      const response = await service.request('http://example.com/login');

      expect(response.setCookie).toEqual(cookies);
    });

    it('hands back one cookie as a list of one, and none as an empty list (#1083)', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('8.8.8.8')]);
      const { service, pool } = buildService({ dns, mockAgent });
      pool.intercept({ path: '/one' }).reply(Http.Ok, { ok: true }, { headers: { 'set-cookie': 'a=1' } });
      pool.intercept({ path: '/none' }).reply(Http.Ok, { ok: true });

      expect((await service.request('http://example.com/one')).setCookie).toEqual(['a=1']);
      expect((await service.request('http://example.com/none')).setCookie).toEqual([]);
    });
  });

  // fetch's Response carries the status line's reason phrase, and a
  // DataGateway driver reports it when a request fails. The plugin HTTP
  // client builds its Response from this answer (#1083).
  it("hands back the final response's reason phrase (#1083)", async () => {
    const dns = new FakeDnsResolver();
    dns.set('example.com', [v4('8.8.8.8')]);
    const { service, pool } = buildService({ dns, mockAgent });
    pool.intercept({ path: '/busy' }).reply(Http.ServiceUnavailable, 'busy');

    const response = await service.request('http://example.com/busy', { responseType: 'text' });

    expect([response.status, response.statusText]).toEqual([Http.ServiceUnavailable, 'Service Unavailable']);
  });

  describe("the caller's signal", () => {
    // The outbound HTTP policy's address lookup takes no signal. A request
    // cancelled before a hop begins must not start one (#1083).
    it('looks no address up for a request that is already cancelled (#1083)', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('8.8.8.8')]);
      const resolveAll = jest.spyOn(dns, 'resolveAll');
      const { service } = buildService({ dns, mockAgent });

      await expect(service.request('http://example.com/a', { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(
        OutboundNetworkError,
      );
      expect(resolveAll).not.toHaveBeenCalled();
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

    // A time limit that is not a timer's duration is a caller's bug. NaN or
    // Infinity used to fail inside the hop and reach the caller as a network
    // error, after the observer heard of a request; anything above 2^31 - 1
    // ms became a 1 ms timer and a false timeout. Refused before any request
    // (#1094).
    it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5, 2 ** 31])(
      'refuses a timeoutMs of %p before any request (#1094)',
      async (timeoutMs) => {
        const dns = new FakeDnsResolver();
        dns.set('example.com', [v4('8.8.8.8')]);
        const onRequest = jest.fn();
        const { service } = buildService({ dns, mockAgent, observer: { onRequest } });

        await expect(service.request('http://example.com/a', { timeoutMs })).rejects.toBeInstanceOf(RangeError);
        expect(onRequest).not.toHaveBeenCalled();
      },
    );

    it('accepts the longest time limit a timer holds (#1094)', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('8.8.8.8')]);
      mockAgent.get('http://example.com').intercept({ path: '/a' }).reply(Http.Ok, { ok: true });

      const { service } = buildService({ dns, mockAgent });
      const response = await service.request('http://example.com/a', { timeoutMs: 2 ** 31 - 1 });

      expect(response.status).toBe(Http.Ok);
    });
  });

  describe('download', () => {
    let dir: string;
    let destination: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'secure-http-download-'));
      destination = join(dir, 'artifact.tgz');
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function dnsFor(...hosts: Array<[string, string]>): FakeDnsResolver {
      const dns = new FakeDnsResolver();
      for (const [host, ip] of hosts) {
        dns.set(host, [v4(ip)]);
      }
      return dns;
    }

    // The cap guards the disk. NaN or Infinity would pass every comparison
    // against it, so a value that is not a byte count is refused (#1094).
    it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
      'refuses a maxBytes of %p before any request (#1094)',
      async (maxBytes) => {
        const dns = dnsFor(['example.com', '8.8.8.8']);
        const onRequest = jest.fn();
        const { service } = buildService({ dns, mockAgent, observer: { onRequest } });

        await expect(
          service.download('http://example.com/a.tgz', { destination, maxBytes, timeoutMs: 5_000 }),
        ).rejects.toBeInstanceOf(RangeError);
        expect(onRequest).not.toHaveBeenCalled();
        expect(existsSync(destination)).toBe(false);
      },
    );

    // The same holds for the redirect cap: NaN or Infinity would never stop
    // a redirect loop short of the time limit (#1094).
    it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
      'refuses a maxRedirects of %p before any request (#1094)',
      async (maxRedirects) => {
        const dns = dnsFor(['example.com', '8.8.8.8']);
        const onRequest = jest.fn();
        const { service } = buildService({ dns, mockAgent, observer: { onRequest } });

        await expect(
          service.download('http://example.com/a.tgz', { destination, maxBytes: 1024, maxRedirects, timeoutMs: 5_000 }),
        ).rejects.toBeInstanceOf(RangeError);
        expect(onRequest).not.toHaveBeenCalled();
        expect(existsSync(destination)).toBe(false);
      },
    );

    // And the time limit: a value that is not a timer's duration is refused
    // with the same RangeError, not Node's own (#1094).
    it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5, 2 ** 31])(
      'refuses a timeoutMs of %p before any request (#1094)',
      async (timeoutMs) => {
        const dns = dnsFor(['example.com', '8.8.8.8']);
        const onRequest = jest.fn();
        const { service } = buildService({ dns, mockAgent, observer: { onRequest } });

        await expect(
          service.download('http://example.com/a.tgz', { destination, maxBytes: 1024, timeoutMs }),
        ).rejects.toThrow(/^timeoutMs must be/);
        expect(onRequest).not.toHaveBeenCalled();
        expect(existsSync(destination)).toBe(false);
      },
    );

    it('writes a 2xx body to the destination and reports its checksum (#1094)', async () => {
      const dns = dnsFor(['example.com', '8.8.8.8']);
      const { service, pool } = buildService({ dns, mockAgent });
      pool.intercept({ path: '/a.tgz' }).reply(Http.Ok, Buffer.from('plugin'));

      const result = await service.download('http://example.com/a.tgz', {
        destination,
        maxBytes: 1024,
        timeoutMs: 5_000,
      });

      expect(result.status).toBe(Http.Ok);
      expect(result.finalUrl).toBe('http://example.com/a.tgz');
      expect(result.written).toEqual({
        bytes: 6,
        sha256: createHash('sha256').update('plugin').digest('hex'),
      });
      expect(readFileSync(destination).toString()).toBe('plugin');
    });

    it.each([
      ['with a content-length', true],
      ['chunked with no length', false],
    ])(
      'stops a body over the cap with ResponseTooLargeError and keeps no file (%s) (#1094)',
      async (_label, withLength) => {
        const dns = dnsFor(['example.com', '8.8.8.8']);
        const { service, pool } = buildService({ dns, mockAgent });
        let requests = 0;
        const body = Buffer.alloc(2048, 1);
        pool.intercept({ path: '/big' }).reply(
          Http.Ok,
          () => {
            requests++;
            return body;
          },
          { headers: withLength ? { 'content-length': String(body.length) } : {} },
        );

        await expect(
          service.download('http://example.com/big', { destination, maxBytes: 1024, timeoutMs: 5_000 }),
        ).rejects.toMatchObject({ name: 'ResponseTooLargeError', limitBytes: 1024 });

        expect(requests).toBe(1);
        expect(existsSync(destination)).toBe(false);
      },
    );

    it("never reads a redirect's body, so a large one does not refuse a small artifact (#1094)", async () => {
      const dns = dnsFor(['example.com', '8.8.8.8']);
      const { service, pool } = buildService({ dns, mockAgent });
      // Over request()'s 10 MiB in-memory ceiling.
      pool
        .intercept({ path: '/r' })
        .reply(Http.Found, Buffer.alloc(11 * 1024 * 1024, 'r'), { headers: { location: 'http://example.com/a.tgz' } });
      pool.intercept({ path: '/a.tgz' }).reply(Http.Ok, Buffer.from('plugin'));

      const result = await service.download('http://example.com/r', { destination, maxBytes: 1024, timeoutMs: 5_000 });

      expect(result.status).toBe(Http.Ok);
      expect(result.redirectCount).toBe(1);
      expect(result.written).toMatchObject({ bytes: 6 });
      expect(readFileSync(destination, 'utf8')).toBe('plugin');
    });

    it('refuses a redirect to a blocked address and writes nothing (#1094)', async () => {
      const dns = dnsFor(['example.com', '8.8.8.8'], ['internal.com', '10.0.0.1']);
      mockAgent
        .get('http://example.com')
        .intercept({ path: '/r' })
        .reply(Http.Found, '', { headers: { location: 'http://internal.com/a.tgz' } });
      const { service } = buildService({ dns, mockAgent });

      await expect(
        service.download('http://example.com/r', { destination, maxBytes: 1024, timeoutMs: 5_000 }),
      ).rejects.toBeInstanceOf(RedirectToDisallowedTargetError);
      expect(existsSync(destination)).toBe(false);
    });

    it('applies one time limit across every hop (#1094)', async () => {
      // Each hop waits at least 60ms, so two hops need at least 120ms against a
      // 100ms limit. A slow runner only makes the hops later, so the limit still
      // fires. Shared limit = rejection; a per-hop limit would let both pass.
      const dns = dnsFor(['example.com', '8.8.8.8']);
      const pool = mockAgent.get('http://example.com');
      pool
        .intercept({ path: '/a' })
        .reply(Http.Found, '', { headers: { location: 'http://example.com/b' } })
        .delay(60);
      pool.intercept({ path: '/b' }).reply(Http.Ok, Buffer.from('plugin')).delay(60);
      const { service } = buildService({ dns, mockAgent });

      await expect(
        service.download('http://example.com/a', { destination, maxBytes: 1024, timeoutMs: 100 }),
      ).rejects.toBeInstanceOf(RequestTimeoutError);
      expect(existsSync(destination)).toBe(false);
    });

    it('writes nothing for a non-2xx answer (#1094)', async () => {
      const dns = dnsFor(['example.com', '8.8.8.8']);
      const { service, pool } = buildService({ dns, mockAgent });
      pool.intercept({ path: '/missing' }).reply(Http.NotFound, 'nope');

      const result = await service.download('http://example.com/missing', {
        destination,
        maxBytes: 1024,
        timeoutMs: 5_000,
      });

      expect(result.status).toBe(Http.NotFound);
      expect(result.written).toBeNull();
      expect(existsSync(destination)).toBe(false);
    });

    it('leaves an existing destination alone and refuses to overwrite it (#1094)', async () => {
      const dns = dnsFor(['example.com', '8.8.8.8']);
      const { service, pool } = buildService({ dns, mockAgent });
      pool.intercept({ path: '/a.tgz' }).reply(Http.Ok, Buffer.from('plugin'));
      writeFileSync(destination, 'keep');

      await expect(
        service.download('http://example.com/a.tgz', { destination, maxBytes: 1024, timeoutMs: 5_000 }),
      ).rejects.toMatchObject({ code: 'EEXIST' });
      expect(readFileSync(destination).toString()).toBe('keep');
    });

    it('maps a network failure to OutboundNetworkError (#1094)', async () => {
      const dns = dnsFor(['example.com', '8.8.8.8']);
      mockAgent.get('http://example.com').intercept({ path: '/' }).replyWithError(new Error('connection reset'));
      const { service } = buildService({ dns, mockAgent });

      await expect(
        service.download('http://example.com/', { destination, maxBytes: 1024, timeoutMs: 5_000 }),
      ).rejects.toBeInstanceOf(OutboundNetworkError);
      expect(existsSync(destination)).toBe(false);
    });
    it('writes a body of exactly maxBytes in full (#1094)', async () => {
      const dns = dnsFor(['example.com', '8.8.8.8']);
      const { service, pool } = buildService({ dns, mockAgent });
      const body = Buffer.alloc(1024, 7);
      pool.intercept({ path: '/exact' }).reply(Http.Ok, body, { headers: { 'content-length': '1024' } });

      const result = await service.download('http://example.com/exact', {
        destination,
        maxBytes: 1024,
        timeoutMs: 5_000,
      });

      expect(result.written).toEqual({ bytes: 1024, sha256: createHash('sha256').update(body).digest('hex') });
      expect(readFileSync(destination).equals(body)).toBe(true);
    });

    it('fires the observer for a destination failure and rethrows it raw (#1094)', async () => {
      const dns = dnsFor(['example.com', '8.8.8.8']);
      const onError = jest.fn();
      const { service, pool } = buildService({ dns, mockAgent, observer: { onError } });
      pool.intercept({ path: '/a.tgz' }).reply(Http.Ok, Buffer.from('plugin'));
      writeFileSync(destination, 'keep');

      await expect(
        service.download('http://example.com/a.tgz', { destination, maxBytes: 1024, timeoutMs: 5_000 }),
      ).rejects.toMatchObject({ code: 'EEXIST' });
      expect(onError).toHaveBeenCalledTimes(1);
    });

    // MockAgent hands over a whole body in one piece, and a body it hands over
    // never raises undici's abort error, so the mid-body cases and the bodies
    // a download leaves unread use a real local server. The dispatcher pins
    // every connection to 127.0.0.1 while the policy still sees a public
    // address, as production pinning does.
    describe('against a real server', () => {
      let server: Server;
      let agent: Agent;
      let port: number;
      let held: ServerResponse[];

      beforeEach(async () => {
        held = [];
      });

      afterEach(async () => {
        for (const res of held) {
          res.destroy();
        }
        await agent.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      });

      async function serve(handler: (res: ServerResponse, req: IncomingMessage) => void): Promise<SecureHttpService> {
        server = createServer((req, res) => {
          held.push(res);
          handler(res, req);
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = (server.address() as AddressInfo).port;
        agent = new Agent({
          connect: {
            // Node asks for every address when it auto-selects a family.
            lookup: (_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) =>
              o?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4),
          },
        } as ConstructorParameters<typeof Agent>[0]);

        const dns = new FakeDnsResolver();
        dns.set('example.com', [v4('8.8.8.8')]);
        jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        jest.spyOn(Logger.prototype, 'error').mockImplementation();
        return new SecureHttpService(
          new StubPolicyService() as unknown as SafeHttpPolicyService,
          new IpPolicyService(dns),
          new FakeDispatcherFactory(agent),
          new NoopOutboundHttpObserver(),
        );
      }

      // Send one chunk, then hold the response open (no more bytes, no end).
      const stallAfterFirstChunk = (res: ServerResponse): void => {
        res.writeHead(Http.Ok);
        res.write(Buffer.alloc(512, 1));
      };

      it('stops after earlier chunks arrived when a later one passes the cap (#1094)', async () => {
        const service = await serve((res) => {
          res.writeHead(Http.Ok);
          res.write(Buffer.alloc(600, 1));
          setTimeout(() => {
            res.write(Buffer.alloc(600, 1));
            res.end();
          }, 50);
        });

        await expect(
          service.download(`http://example.com:${port}/chunked`, { destination, maxBytes: 1024, timeoutMs: 5_000 }),
        ).rejects.toBeInstanceOf(ResponseTooLargeError);
        expect(existsSync(destination)).toBe(false);
      });

      it('removes the file when the time limit fires mid-body (#1094)', async () => {
        // The server never finishes the body, so only the limit can end the
        // download. A slow runner only makes the limit fire sooner or later;
        // either way the result is a timeout and no file.
        const service = await serve(stallAfterFirstChunk);

        await expect(
          service.download(`http://example.com:${port}/stall`, { destination, maxBytes: 1024, timeoutMs: 400 }),
        ).rejects.toBeInstanceOf(RequestTimeoutError);
        expect(existsSync(destination)).toBe(false);
      });

      it('removes the file when the caller aborts mid-body, as OutboundNetworkError (#1094)', async () => {
        const controller = new AbortController();
        const service = await serve((res) => {
          stallAfterFirstChunk(res);
          setTimeout(() => controller.abort(), 100);
        });

        await expect(
          service.download(`http://example.com:${port}/stall`, {
            destination,
            maxBytes: 1024,
            timeoutMs: 30_000,
            signal: controller.signal,
          }),
        ).rejects.toBeInstanceOf(OutboundNetworkError);
        expect(existsSync(destination)).toBe(false);
      });

      // A body that is dropped unread, destroyed before its end, emits undici's
      // RequestAbortedError. With no listener that `error` event crashes the
      // process, and Jest fails the test on it. It is emitted a turn after the
      // download settles, so each test waits for it (#1094).
      const unreadBodiesSettle = async (): Promise<void> => {
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
      };

      it("drops a redirect's body without an unhandled error (#1094)", async () => {
        const service = await serve((res, req) => {
          if (req.url === '/moved') {
            res.writeHead(Http.Found, { location: '/a.tgz' });
            res.end('moved');
            return;
          }
          res.end('plugin');
        });

        const result = await service.download(`http://example.com:${port}/moved`, {
          destination,
          maxBytes: 1024,
          timeoutMs: 5_000,
        });
        await unreadBodiesSettle();

        expect(result.redirectCount).toBe(1);
        expect(readFileSync(destination).toString()).toBe('plugin');
      });

      it("drops a non-2xx answer's body without an unhandled error (#1094)", async () => {
        const service = await serve((res) => {
          res.writeHead(Http.NotFound);
          res.end('not here');
        });

        const result = await service.download(`http://example.com:${port}/a.tgz`, {
          destination,
          maxBytes: 1024,
          timeoutMs: 5_000,
        });
        await unreadBodiesSettle();

        expect(result.written).toBeNull();
        expect(existsSync(destination)).toBe(false);
      });

      it('drops the body for an existing destination without an unhandled error (#1094)', async () => {
        const service = await serve((res) => res.end('plugin'));
        writeFileSync(destination, 'keep');

        await expect(
          service.download(`http://example.com:${port}/a.tgz`, { destination, maxBytes: 1024, timeoutMs: 5_000 }),
        ).rejects.toMatchObject({ code: 'EEXIST' });
        await unreadBodiesSettle();

        expect(readFileSync(destination).toString()).toBe('keep');
      });

      it('drops a body declared over the cap without an unhandled error (#1094)', async () => {
        const service = await serve((res) => res.end(Buffer.alloc(2048, 1)));

        await expect(
          service.download(`http://example.com:${port}/a.tgz`, { destination, maxBytes: 1024, timeoutMs: 5_000 }),
        ).rejects.toBeInstanceOf(ResponseTooLargeError);
        await unreadBodiesSettle();

        expect(existsSync(destination)).toBe(false);
      });
    });
  });

  describe('request() and an oversized body', () => {
    it('request() does not retry a body over the cap (#1094)', async () => {
      const dns = new FakeDnsResolver();
      dns.set('example.com', [v4('8.8.8.8')]);
      let requests = 0;
      const big = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
      mockAgent
        .get('http://example.com')
        .intercept({ path: '/huge' })
        .reply(Http.Ok, () => {
          requests++;
          return big;
        })
        .persist();
      const { service } = buildService({ dns, mockAgent });

      await expect(
        service.request('http://example.com/huge', { retry: { attempts: 3, baseDelayMs: 1 } }),
      ).rejects.toBeInstanceOf(ResponseTooLargeError);
      expect(requests).toBe(1);
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
