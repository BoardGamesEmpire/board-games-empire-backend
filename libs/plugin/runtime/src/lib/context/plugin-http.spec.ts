import {
  HostNotAllowedError,
  InvalidRequestUrlError,
  OutboundNetworkError,
  RedirectLimitExceededError,
  RedirectToDisallowedTargetError,
  RequestTimeoutError,
  ResponseTooLargeError,
  SsrfRejectionError,
  type SafeHttpRequestOptions,
  type SafeHttpResponse,
  type SecureHttpService,
} from '@bge/secure-http';
import type { UpstreamFetch } from '@boardgamesempire/gateway-driver-contract';
import {
  PluginHttpRequestFailedError,
  PluginOutboundDomainNotDeclaredError,
  PluginOutboundDomainsNotSupportedError,
} from './context.errors';
import { buildPluginHttp } from './plugin-http';

describe('buildPluginHttp', () => {
  const slug = 'demo-gateway';
  const declared = ['api.example.com'];

  let request: jest.Mock;
  let secureHttp: Pick<SecureHttpService, 'request'>;

  const bytesOf = (text: string): ArrayBuffer => {
    const encoded = new TextEncoder().encode(text);
    return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
  };

  const answer = (overrides: Partial<SafeHttpResponse<ArrayBuffer>> = {}): SafeHttpResponse<ArrayBuffer> => ({
    status: 200,
    statusText: 'OK',
    headers: {},
    body: new ArrayBuffer(0),
    raw: new ArrayBuffer(0),
    durationMs: 1,
    finalUrl: 'https://api.example.com/',
    redirectCount: 0,
    setCookie: [],
    ...overrides,
  });

  /** The options the client handed to the secure HTTP service on a call. */
  const optionsOf = (call = 0): SafeHttpRequestOptions => request.mock.calls[call][1];

  beforeEach(() => {
    request = jest.fn().mockResolvedValue(answer());
    secureHttp = { request } as unknown as Pick<SecureHttpService, 'request'>;
  });

  it('passes a declared host through under the outbound HTTP policy (#1083)', async () => {
    request.mockResolvedValue(
      answer({
        status: 201,
        headers: { 'content-type': 'application/json', 'x-trace': 't-1' },
        body: bytesOf('{"ok":true}'),
      }),
    );
    const controller = new AbortController();
    const http = buildPluginHttp(slug, declared, secureHttp);

    const response = await http.fetch('https://api.example.com/v1/games?id=7', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"q":"catan"}',
      signal: controller.signal,
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      'https://api.example.com/v1/games?id=7',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'content-type': 'application/json' }),
        body: '{"q":"catan"}',
        signal: controller.signal,
        responseType: 'arraybuffer',
        allowHost: expect.any(Function),
      }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get('x-trace')).toBe('t-1');
    expect(await response.json()).toEqual({ ok: true });
  });

  // The service asks the rule with `URL.hostname` of every hop, which never
  // carries a port, so a declared host passes on any port. The plugin
  // manifest declares bare lowercase names, so a host in capitals or written with the
  // DNS root's trailing dot is still that host; anything else is not, an IP
  // literal included (#1083).
  it('allowHost accepts a declared host in capitals or with a trailing dot, and nothing else (#1083)', async () => {
    await buildPluginHttp(slug, declared, secureHttp).fetch('https://api.example.com/', { method: 'GET', headers: {} });
    const allowHost = optionsOf().allowHost as (hostname: string) => boolean;

    expect(allowHost('API.Example.com')).toBe(true);
    expect(allowHost('api.example.com.')).toBe(true);
    for (const hostname of ['evil.example.com', 'example.com', 'sub.api.example.com', '1.2.3.4', 'api.example.com..']) {
      expect([hostname, allowHost(hostname)]).toEqual([hostname, false]);
    }
  });

  // A plugin recognises the refusal by its own runtime's code, without
  // importing the secure HTTP lib. The message names the hostname and never
  // the URL, whose query can carry a token (#1083).
  it("turns a host refusal into the plugin's own coded error (#1083)", async () => {
    const refusals = [
      new HostNotAllowedError('evil.example.com'),
      new RedirectToDisallowedTargetError(
        'https://api.example.com/r?token=s3cret',
        'https://evil.example.com/x?token=s3cret',
        new HostNotAllowedError('evil.example.com'),
      ),
    ];

    for (const refusal of refusals) {
      request.mockRejectedValueOnce(refusal);

      const err = await buildPluginHttp(slug, declared, secureHttp)
        .fetch('https://api.example.com/r?token=s3cret', { method: 'GET', headers: {} })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PluginOutboundDomainNotDeclaredError);
      expect(err).toMatchObject({ code: 'PLUGIN_OUTBOUND_DOMAIN_NOT_DECLARED', slug, hostname: 'evil.example.com' });
      expect((err as Error).message).toContain("'evil.example.com'");
      expect((err as Error).message).not.toContain('s3cret');
    }
  });

  // The secure HTTP service's errors name the whole URL, and a redirect's
  // target, in their message and fields. A DataGateway driver may put a
  // secret in a URL's query and copy `err.message` into its log and its
  // answer to the searching user, so a failure reaches the plugin as the
  // runtime's own error: the service's code and the host the plugin asked
  // for, nothing else, and no `cause` a logger could print (#1083).
  describe('a failed request names the host, never the URL (#1083)', () => {
    const asked = 'https://api.example.com/v1/secret-path?token=s3cret';
    const redirectTarget = 'https://internal.example.com/admin?token=s3cret';

    /** Everything a log line could print from the error. */
    const printed = (err: Error): string[] => [JSON.stringify(err), err.message, err.stack ?? ''];

    it.each([
      ['a timeout', 'REQUEST_TIMEOUT', new RequestTimeoutError(asked, 5_000)],
      [
        'a network error',
        'OUTBOUND_NETWORK_ERROR',
        new OutboundNetworkError(asked, new Error(`connect ECONNRESET for ${asked}`)),
      ],
      [
        'a redirect the outbound HTTP policy refuses',
        'REDIRECT_DENIED',
        new RedirectToDisallowedTargetError(
          asked,
          redirectTarget,
          new SsrfRejectionError('internal.example.com', 'private-range', '10.0.0.1'),
        ),
      ],
      ['an address the policy refuses', 'SSRF_REJECTION', new SsrfRejectionError('api.example.com', 'private-range')],
      ['too many redirects', 'REDIRECT_LIMIT_EXCEEDED', new RedirectLimitExceededError(asked, 5)],
      ['an answer over the size limit', 'RESPONSE_TOO_LARGE', new ResponseTooLargeError(asked, 10)],
      ['a scheme the client cannot send', 'INVALID_REQUEST_URL', new InvalidRequestUrlError(asked, 'invalid-scheme')],
    ])("%s rejects as the runtime's own coded error (#1083)", async (_label, code, failure) => {
      request.mockRejectedValueOnce(failure);

      const err = (await buildPluginHttp(slug, declared, secureHttp)
        .fetch(asked, { method: 'GET', headers: {} })
        .catch((e: unknown) => e)) as Error;

      expect(err).toBeInstanceOf(PluginHttpRequestFailedError);
      expect(err).toMatchObject({ code, slug, hostname: 'api.example.com' });
      expect(err).not.toHaveProperty('cause');
      for (const text of printed(err)) {
        expect(text).not.toContain('secret-path');
        expect(text).not.toContain('s3cret');
        expect(text).not.toContain('internal.example.com');
      }
    });

    // Node's URL parser puts the input on its TypeError, so that error must
    // not reach the plugin either.
    it("refuses a URL it can't parse with the runtime's own coded error, without calling out (#1083)", async () => {
      const err = (await buildPluginHttp(slug, declared, secureHttp)
        .fetch('api.example.com/v1/secret-path?token=s3cret', { method: 'GET', headers: {} })
        .catch((e: unknown) => e)) as Error;

      expect(err).toBeInstanceOf(PluginHttpRequestFailedError);
      expect(err).toMatchObject({ code: 'INVALID_REQUEST_URL', slug, hostname: null });
      expect(err).not.toHaveProperty('cause');
      for (const text of printed(err)) {
        expect(text).not.toContain('secret-path');
        expect(text).not.toContain('s3cret');
      }
      expect(request).not.toHaveBeenCalled();
    });

    // `new URL` parses these, with an empty hostname. There is no host to
    // name, so the plugin gets the null the contract promises, not ''.
    it.each(['file:///etc/secret-path?token=s3cret', 'mailto:s3cret@example.com', 'data:text/plain,s3cret'])(
      'refuses %s, a URL that names no host, with a null hostname and without calling out (#1083)',
      async (url) => {
        const err = (await buildPluginHttp(slug, declared, secureHttp)
          .fetch(url, { method: 'GET', headers: {} })
          .catch((e: unknown) => e)) as Error;

        expect(err).toBeInstanceOf(PluginHttpRequestFailedError);
        expect(err).toMatchObject({ code: 'INVALID_REQUEST_URL', slug, hostname: null });
        for (const text of printed(err)) {
          expect(text).not.toContain('s3cret');
          expect(text).not.toContain("''");
        }
        expect(request).not.toHaveBeenCalled();
      },
    );

    it('lets an error that is not a request failure propagate as it is (#1083)', async () => {
      const bug = new TypeError('a bug in the service');
      request.mockRejectedValueOnce(bug);

      await expect(
        buildPluginHttp(slug, declared, secureHttp).fetch('https://api.example.com/', { method: 'GET', headers: {} }),
      ).rejects.toBe(bug);
    });
  });

  // `configured` means the hosts come from the plugin's configuration, which
  // the client can't hold it to yet. Refusing is the bounded answer (#1293).
  it('refuses every request of a plugin that declares configured, without calling out (#1293)', async () => {
    const http = buildPluginHttp(slug, 'configured', secureHttp);

    await expect(http.fetch('https://api.example.com/', { method: 'GET', headers: {} })).rejects.toMatchObject({
      constructor: PluginOutboundDomainsNotSupportedError,
      code: 'PLUGIN_OUTBOUND_DOMAINS_CONFIGURED_UNSUPPORTED',
      slug,
    });
    expect(request).not.toHaveBeenCalled();
  });

  // The secure HTTP service hands back the bytes as they arrived and doesn't
  // decompress, and the plugin's Response is built from them: a gzip answer
  // would break `response.json()`. So the client asks for the identity
  // encoding whatever the plugin passed, in any letter case (#1083).
  it('never asks for compression (#1083)', async () => {
    await buildPluginHttp(slug, declared, secureHttp).fetch('https://api.example.com/', {
      method: 'GET',
      headers: { 'Accept-Encoding': 'gzip', 'ACCEPT-ENCODING': 'br', 'accept-encoding': 'zstd', 'x-api-key': 'k' },
    });

    expect(optionsOf().headers).toEqual({ 'x-api-key': 'k', 'accept-encoding': 'identity' });
  });

  // The Response constructor refuses a body, even an empty one, for these
  // statuses, so the answer's empty bytes must not be handed to it.
  it('builds a bodiless Response for 204, 205 and 304 (#1083)', async () => {
    for (const status of [204, 205, 304]) {
      request.mockResolvedValueOnce(answer({ status, headers: { etag: '"v1"' } }));

      const response = await buildPluginHttp(slug, declared, secureHttp).fetch('https://api.example.com/', {
        method: 'GET',
        headers: {},
      });

      expect([status, response.status, response.body]).toEqual([status, status, null]);
      expect(response.headers.get('etag')).toBe('"v1"');
    }
  });

  // The service reports a cancelled request as a network error. A
  // DataGateway driver cancels on purpose, when its caller unsubscribes, and
  // must be able to tell that from an upstream outage, so the rejection is
  // the signal's own reason, as with fetch (#1083).
  describe('a request the plugin cancels (#1083)', () => {
    const asked = 'https://api.example.com/v1/games?token=s3cret';

    it("rejects with the signal's reason, an AbortError by default (#1083)", async () => {
      const controller = new AbortController();
      request.mockImplementationOnce(async () => {
        controller.abort();
        throw new OutboundNetworkError(asked, new Error('This operation was aborted'));
      });

      const err = (await buildPluginHttp(slug, declared, secureHttp)
        .fetch(asked, { method: 'GET', headers: {}, signal: controller.signal })
        .catch((e: unknown) => e)) as Error;

      expect(err).toBe(controller.signal.reason);
      expect(err.name).toBe('AbortError');
      expect(err.message).not.toContain('s3cret');
    });

    it('rejects with the reason the plugin gave (#1083)', async () => {
      const reason = new Error('the search was unsubscribed');
      request.mockRejectedValueOnce(new OutboundNetworkError(asked, reason));

      await expect(
        buildPluginHttp(slug, declared, secureHttp).fetch(asked, {
          method: 'GET',
          headers: {},
          signal: AbortSignal.abort(reason),
        }),
      ).rejects.toBe(reason);
    });

    it('still reports a failure as a failure while the signal is not aborted (#1083)', async () => {
      request.mockRejectedValueOnce(new OutboundNetworkError(asked, new Error('connect ECONNRESET')));

      await expect(
        buildPluginHttp(slug, declared, secureHttp).fetch(asked, {
          method: 'GET',
          headers: {},
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'OUTBOUND_NETWORK_ERROR', hostname: 'api.example.com' });
    });

    it('does not hide a bug behind the cancellation (#1083)', async () => {
      const bug = new TypeError('a bug in the service');
      request.mockRejectedValueOnce(bug);

      await expect(
        buildPluginHttp(slug, declared, secureHttp).fetch(asked, {
          method: 'GET',
          headers: {},
          signal: AbortSignal.abort(),
        }),
      ).rejects.toBe(bug);
    });
  });

  // The Response constructor takes a status from 200 to 599 only, and takes
  // neither a URL nor a redirect flag. fetch hands back all of them, and a
  // DataGateway driver written against fetch reads them (#1083).
  describe('what the Response constructor does not take (#1083)', () => {
    const get = (url = 'https://api.example.com/'): Promise<Response> =>
      buildPluginHttp(slug, declared, secureHttp).fetch(url, { method: 'GET', headers: {} });

    // Some upstreams answer outside the registered range: 999 is a known
    // "request denied". fetch resolves with it, and so does this client.
    it.each([999, 600, 199])('resolves a status the constructor refuses: %d (#1083)', async (status) => {
      request.mockResolvedValueOnce(answer({ status, body: bytesOf('denied') }));

      const response = await get();

      expect([response.status, response.ok]).toEqual([status, false]);
      expect(await response.clone().text()).toBe('denied');
      expect([response.clone().status, response.clone().ok]).toEqual([status, false]);
    });

    it('keeps ok true for a 2xx status and false for any other (#1083)', async () => {
      for (const [status, ok] of [
        [200, true],
        [299, true],
        [301, false],
        [404, false],
        [503, false],
      ] as const) {
        request.mockResolvedValueOnce(answer({ status }));

        const response = await get();

        expect([status, response.status, response.ok]).toEqual([status, status, ok]);
      }
    });

    it('carries the URL that answered and whether a redirect led there (#1083)', async () => {
      request.mockResolvedValueOnce(answer({ finalUrl: 'https://api.example.com/v2/games?page=1', redirectCount: 2 }));

      const response = await get('https://api.example.com/v1/games');

      expect([response.url, response.redirected]).toEqual(['https://api.example.com/v2/games?page=1', true]);
      expect(new URL('?page=2', response.url).href).toBe('https://api.example.com/v2/games?page=2');
      const copy = response.clone().clone();
      expect([copy.url, copy.redirected]).toEqual([response.url, true]);
    });

    it('says no redirect happened when none did (#1083)', async () => {
      const response = await get();

      expect([response.url, response.redirected]).toEqual(['https://api.example.com/', false]);
    });

    // A driver reports the reason phrase when a request fails, as the IGDB
    // driver's token request does. The constructor throws on a character
    // outside Latin-1, which a UTF-8 status line can hold (#1083).
    it.each([
      [503, 'Service Unavailable'],
      [999, 'Request denied ✓'],
      [204, ''],
    ])('carries the reason phrase of a %d, a copy too (#1083)', async (status, statusText) => {
      request.mockResolvedValueOnce(answer({ status, statusText }));

      const response = await get();

      expect([response.status, response.statusText]).toEqual([status, statusText]);
      expect(response.clone().clone().statusText).toBe(statusText);
    });
  });

  // The service joins a repeated header with a comma, and a cookie's Expires
  // date holds one, so joined cookies can't be split again. The client takes
  // them from the service's own list (#1083).
  it('keeps each Set-Cookie header by itself (#1083)', async () => {
    const cookies = ['a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT', 'b=2'];
    request.mockResolvedValueOnce(
      answer({ headers: { 'set-cookie': cookies.join(', '), 'x-trace': 't-1' }, setCookie: cookies }),
    );

    const response = await buildPluginHttp(slug, declared, secureHttp).fetch('https://api.example.com/', {
      method: 'GET',
      headers: {},
    });

    expect(response.headers.getSetCookie()).toEqual(cookies);
    expect(response.headers.get('x-trace')).toBe('t-1');
  });

  // A data-gateway plugin hands its client to its DataGateway driver as the
  // driver's upstream fetch. The plugin contract can't import the gateway
  // contract, so this assignment, checked by the typecheck, is what keeps the
  // two shapes together (#1083).
  it('fits where a DataGateway driver takes its upstream fetch (#1083)', () => {
    const fetch: UpstreamFetch = buildPluginHttp(slug, declared, secureHttp).fetch;

    expect(fetch).toBeInstanceOf(Function);
  });
});
