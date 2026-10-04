import { useGateway } from '@bge/testing-e2e/gateway';
import { useTokenEndpoint } from '../support/token-endpoint';

/**
 * The gateway as a host meets it: the built bundle running as its own
 * process, reached over a real gRPC channel. It fetches its Twitch token at
 * boot, from a local endpoint here, and each RPC below is answered by the
 * gateway itself, so nothing reaches Twitch or IGDB. Search and fetch through
 * a running gateway are #614's.
 */
describe('the IGDB gateway over gRPC', () => {
  const tokenEndpoint = useTokenEndpoint();

  const gateway = useGateway({
    app: 'igdb-gateway',
    label: 'IGDB gateway',
    hostEnv: 'IGDB_GATEWAY_GRPC_HOST',
    portEnv: 'IGDB_GATEWAY_GRPC_PORT',
    // Placeholders, set so that real credentials in a developer's `.env`
    // never reach a test run. The gateway refuses to boot without them.
    env: () => ({
      ...process.env,
      IGDB_CLIENT_ID: 'e2e-client-id',
      IGDB_CLIENT_SECRET: 'e2e-client-secret',
      IGDB_TOKEN_URL: tokenEndpoint.url(),
    }),
  });

  it('fetched its access token at boot from IGDB_TOKEN_URL, with its client credentials', () => {
    // One request per boot, made before the gateway binds its port. A launch
    // that lost its port and was retried on another booted twice, so the
    // count is not pinned to one.
    const requests = tokenEndpoint.requests();

    expect(requests).not.toHaveLength(0);
    for (const request of requests) {
      expect(request).toEqual({
        client_id: 'e2e-client-id',
        client_secret: 'e2e-client-secret',
        grant_type: 'client_credentials',
      });
    }
  });

  it('reports itself SERVING on Check', async () => {
    await expect(gateway().check()).resolves.toEqual({ status: 'SERVING' });
  });

  it('identifies itself on Ping and echoes the correlation id', async () => {
    const sentAt = Date.now();
    const reply = await gateway().ping('e2e-ping');

    expect(reply).toMatchObject({
      correlationId: 'e2e-ping',
      gatewayName: 'IgdbGateway',
      supportedServices: ['GatewayService'],
      languagePreferences: {
        acceptedRequestFormats: ['LANGUAGE_CODE_FORMAT_IETF_BCP_47', 'LANGUAGE_CODE_FORMAT_ISO_639_1'],
        responseFormat: 'LANGUAGE_CODE_FORMAT_IETF_BCP_47',
        passthroughRawLocale: false,
      },
    });

    // An int64 on the wire: the server's clock reading, taken during the call.
    expect(Number(reply.timestampMs)).toBeGreaterThanOrEqual(sentAt);
    expect(Number(reply.timestampMs)).toBeLessThanOrEqual(Date.now());
  });

  it('lists its languages by BCP 47 tag', async () => {
    const reply = await gateway().listLanguages('e2e-languages');

    expect(reply.correlationId).toBe('e2e-languages');
    expect(reply.languages).toContainEqual(
      expect.objectContaining({ value: 'en-US', format: 'LANGUAGE_CODE_FORMAT_IETF_BCP_47', ietfTag: 'en-US' }),
    );
    expect(reply.languages.filter((language) => language.format !== 'LANGUAGE_CODE_FORMAT_IETF_BCP_47')).toEqual([]);
  });
});
