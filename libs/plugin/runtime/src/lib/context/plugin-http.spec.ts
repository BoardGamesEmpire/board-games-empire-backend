import {
  HostNotAllowedError,
  RedirectToDisallowedTargetError,
  RequestTimeoutError,
  SsrfRejectionError,
  type SafeHttpRequestOptions,
  type SafeHttpResponse,
  type SecureHttpService,
} from '@bge/secure-http';
import type { UpstreamFetch } from '@boardgamesempire/gateway-driver-contract';
import { PluginOutboundDomainNotDeclaredError, PluginOutboundDomainsNotSupportedError } from './context.errors';
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
    headers: {},
    body: new ArrayBuffer(0),
    raw: new ArrayBuffer(0),
    durationMs: 1,
    finalUrl: 'https://api.example.com/',
    redirectCount: 0,
    ...overrides,
  });

  /** The options the client handed to the secure HTTP service on a call. */
  const optionsOf = (call = 0): SafeHttpRequestOptions => request.mock.calls[call][1];

  beforeEach(() => {
    request = jest.fn().mockResolvedValue(answer());
    secureHttp = { request } as unknown as Pick<SecureHttpService, 'request'>;
  });

  it('passes a declared host through under the outbound HTTP policy', async () => {
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
  // carries a port, so a declared host passes on any port. The manifest
  // declares bare lowercase names, so a host in capitals or written with the
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

  it('passes every other SafeHttpError through as it is', async () => {
    const others = [
      new SsrfRejectionError('api.example.com', 'private-range', '10.0.0.1'),
      new RedirectToDisallowedTargetError(
        'https://api.example.com/r',
        'https://api.example.com/internal',
        new SsrfRejectionError('api.example.com', 'private-range', '10.0.0.1'),
      ),
      new RequestTimeoutError('https://api.example.com/slow', 5_000),
    ];

    for (const other of others) {
      request.mockRejectedValueOnce(other);

      await expect(
        buildPluginHttp(slug, declared, secureHttp).fetch('https://api.example.com/', { method: 'GET', headers: {} }),
      ).rejects.toBe(other);
    }
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
  it('builds a bodiless Response for 204, 205 and 304', async () => {
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

  // A data-gateway plugin hands its client to its DataGateway driver as the
  // driver's upstream fetch. The plugin contract can't import the gateway
  // contract, so this assignment, checked by the typecheck, is what keeps the
  // two shapes together (#1083).
  it('fits where a DataGateway driver takes its upstream fetch (#1083)', () => {
    const fetch: UpstreamFetch = buildPluginHttp(slug, declared, secureHttp).fetch;

    expect(fetch).toBeInstanceOf(Function);
  });
});
