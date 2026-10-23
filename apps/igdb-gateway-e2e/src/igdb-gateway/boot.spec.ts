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

    expect(reply).toMatchObject({ correlationId: 'e2e-ping', gatewayName: 'IgdbGateway' });

    // An int64 on the wire: the server's clock reading, taken during the call.
    expect(Number(reply.timestampMs)).toBeGreaterThanOrEqual(sentAt);
    expect(Number(reply.timestampMs)).toBeLessThanOrEqual(Date.now());
  });

  it('describes its operations, coverage and formats on Describe, and echoes the correlation id', async () => {
    const reply = await gateway().describe('e2e-describe');

    expect(reply).toMatchObject({
      correlationId: 'e2e-describe',
      capabilities: [
        'CAPABILITY_SEARCH',
        'CAPABILITY_FETCH',
        'CAPABILITY_FETCH_EXPANSIONS',
        'CAPABILITY_LIST_LANGUAGES',
        'CAPABILITY_LIST_PLATFORMS',
        'CAPABILITY_LIST_CATEGORIES',
      ],
      filterableAxes: ['SEARCH_FILTER_AXIS_PLATFORM_TYPE', 'SEARCH_FILTER_AXIS_CONTENT_TYPE'],
      languageCodeFormats: {
        acceptedRequestFormats: ['LANGUAGE_CODE_FORMAT_IETF_BCP_47', 'LANGUAGE_CODE_FORMAT_ISO_639_1'],
        responseFormat: 'LANGUAGE_CODE_FORMAT_IETF_BCP_47',
        passthroughSearchLanguage: false,
      },
      contentFormat: 'CONTENT_FORMAT_PLAIN_TEXT',
    });

    // Coverage's lists are sets: their order is the game mapper's, and means nothing.
    expect(new Set(reply.coverage?.platformTypes)).toEqual(
      new Set([
        'PLATFORM_TYPE_CONSOLE',
        'PLATFORM_TYPE_PC',
        'PLATFORM_TYPE_PORTABLE',
        'PLATFORM_TYPE_MOBILE',
        'PLATFORM_TYPE_ARCADE',
        'PLATFORM_TYPE_OTHER',
      ]),
    );
    expect(new Set(reply.coverage?.contentTypes)).toEqual(
      new Set([
        'CONTENT_TYPE_BASE_GAME',
        'CONTENT_TYPE_EXPANSION',
        'CONTENT_TYPE_DLC',
        'CONTENT_TYPE_STANDALONE_EXPANSION',
        'CONTENT_TYPE_BUNDLE',
        'CONTENT_TYPE_REMAKE',
        'CONTENT_TYPE_REMASTER',
        'CONTENT_TYPE_EXPANDED_EDITION',
        'CONTENT_TYPE_PORT',
        'CONTENT_TYPE_MOD',
      ]),
    );
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
