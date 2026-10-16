import { useGateway } from '@bge/testing-e2e/gateway';

/**
 * The gateway as a host meets it: the built bundle running as its own
 * process, reached over a real gRPC channel. Each RPC here is answered by the
 * gateway itself, so nothing reaches BoardGameGeek. Search and fetch through
 * a running gateway are #614's.
 */
describe('the BoardGameGeek gateway over gRPC', () => {
  const gateway = useGateway({
    app: 'boardgamegeek-gateway',
    label: 'BoardGameGeek gateway',
    hostEnv: 'BOARDGAMEGEEK_GATEWAY_GRPC_HOST',
    portEnv: 'BOARDGAMEGEEK_GATEWAY_GRPC_PORT',
    // A placeholder, set so that a real key in a developer's `.env` never
    // reaches a test run. The gateway refuses to boot without one.
    env: () => ({ ...process.env, BOARDGAMEGEEK_API_KEY: 'e2e-placeholder-key' }),
  });

  it('reports itself SERVING on Check', async () => {
    await expect(gateway().check()).resolves.toEqual({ status: 'SERVING' });
  });

  it('identifies itself on Ping and echoes the correlation id', async () => {
    const sentAt = Date.now();
    const reply = await gateway().ping('e2e-ping');

    expect(reply).toMatchObject({ correlationId: 'e2e-ping', gatewayName: 'BoardGameGeekGateway' });

    // An int64 on the wire: the server's clock reading, taken during the call.
    expect(Number(reply.timestampMs)).toBeGreaterThanOrEqual(sentAt);
    expect(Number(reply.timestampMs)).toBeLessThanOrEqual(Date.now());
  });

  it('describes its operations, coverage and formats on Describe, and echoes the correlation id', async () => {
    await expect(gateway().describe('e2e-describe')).resolves.toEqual({
      correlationId: 'e2e-describe',
      capabilities: [
        'CAPABILITY_SEARCH',
        'CAPABILITY_FETCH',
        'CAPABILITY_FETCH_EXPANSIONS',
        'CAPABILITY_LIST_LANGUAGES',
      ],
      coverage: {
        platformTypes: ['PLATFORM_TYPE_TABLETOP'],
        contentTypes: ['CONTENT_TYPE_BASE_GAME', 'CONTENT_TYPE_EXPANSION'],
      },
      filterableAxes: [],
      languageCodeFormats: {
        acceptedRequestFormats: ['LANGUAGE_CODE_FORMAT_NAME'],
        responseFormat: 'LANGUAGE_CODE_FORMAT_NAME',
        passthroughSearchLanguage: false,
      },
      contentFormat: 'CONTENT_FORMAT_PLAIN_TEXT',
    });
  });

  it('lists its languages by English display name', async () => {
    const reply = await gateway().listLanguages('e2e-languages');

    expect(reply.correlationId).toBe('e2e-languages');
    expect(reply.languages).toContainEqual(
      expect.objectContaining({ value: 'English', format: 'LANGUAGE_CODE_FORMAT_NAME', iso6393: 'eng', iso6391: 'en' }),
    );
    expect(reply.languages.filter((language) => language.format !== 'LANGUAGE_CODE_FORMAT_NAME')).toEqual([]);
  });
});
