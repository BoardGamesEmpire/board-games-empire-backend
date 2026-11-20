import http from 'node:http';
import { Writable } from 'node:stream';
import type { LoggerOptions, TransportTargetOptions } from 'pino';
import pino from 'pino';
import pinoHttp from 'pino-http';
import request from 'supertest';
import type { LogDestination } from './base-pino.options';
import { buildBasePinoOptions, buildRequestSerializer, resolvePinoLevel } from './base-pino.options';

/**
 * Narrows the loose `LoggerOptions['transport']` to the multi-target
 * shape that {@link buildBasePinoOptions} always produces. Lets every
 * assertion in this file address `targets` without `any` casts.
 */
const getTargets = (transport: unknown): TransportTargetOptions[] => {
  if (transport && typeof transport === 'object' && 'targets' in transport) {
    const targets = (transport as { targets: unknown }).targets;
    if (Array.isArray(targets)) {
      return targets as TransportTargetOptions[];
    }
  }

  throw new Error('expected transport to expose targets[]');
};

// Passed explicitly so no assertion depends on whether Jest itself runs on a terminal.
const TERMINAL = { isTTY: true };

/**
 * The base options at debug, without their transport, for a logger writing to
 * a stream the spec reads: pino refuses a destination stream alongside a
 * transport.
 */
const optionsWithoutTransport = (): LoggerOptions => {
  const options = buildBasePinoOptions({ LOG_LEVEL: 'debug' });
  delete options.transport;

  return options;
};

/** Headers carrying a credential of each kind the base options redact. */
const CREDENTIAL_HEADERS = {
  Authorization: 'Bearer bearer-secret',
  Cookie: 'bge.session=cookie-secret',
  'X-API-Key': 'key-secret',
};

describe('resolvePinoLevel', () => {
  it('uses LOG_LEVEL when set', () => {
    expect(resolvePinoLevel({ LOG_LEVEL: 'trace' })).toBe('trace');
  });

  it('defaults to "info" when NODE_ENV is "production" and LOG_LEVEL is unset', () => {
    expect(resolvePinoLevel({ NODE_ENV: 'production' })).toBe('info');
  });

  it('defaults to "debug" when NODE_ENV is not "production" and LOG_LEVEL is unset', () => {
    expect(resolvePinoLevel({ NODE_ENV: 'development' })).toBe('debug');
  });

  it('defaults to "debug" when both NODE_ENV and LOG_LEVEL are unset', () => {
    expect(resolvePinoLevel({})).toBe('debug');
  });

  it('lets LOG_LEVEL override the NODE_ENV-derived default', () => {
    expect(resolvePinoLevel({ NODE_ENV: 'production', LOG_LEVEL: 'trace' })).toBe('trace');
  });
});

describe('buildBasePinoOptions', () => {
  it('always configures at least one transport target', () => {
    const options = buildBasePinoOptions({}, TERMINAL);

    expect(getTargets(options.transport)).toHaveLength(1);
  });

  it('pretty-prints with colour when stdout is a terminal', () => {
    const targets = getTargets(buildBasePinoOptions({}, { isTTY: true }).transport);

    expect(targets).toEqual([{ target: 'pino-pretty', level: 'debug', options: { colorize: true, singleLine: true } }]);
  });

  it('writes JSON lines to stdout when stdout is not a terminal (#627)', () => {
    const targets = getTargets(buildBasePinoOptions({}, { isTTY: false }).transport);

    expect(targets).toEqual([{ target: 'pino/file', level: 'debug', options: { destination: 1 } }]);
  });

  it('treats a stream without isTTY as no terminal (#627)', () => {
    // A piped process.stdout has no isTTY property at runtime, though its type declares one.
    const targets = getTargets(buildBasePinoOptions({}, {} as LogDestination).transport);

    expect(targets).toEqual([{ target: 'pino/file', level: 'debug', options: { destination: 1 } }]);
  });

  it('applies the resolved level to the top-level options', () => {
    const options = buildBasePinoOptions({ LOG_LEVEL: 'warn' }, TERMINAL);

    expect(options.level).toBe('warn');
  });

  it('applies the resolved level to every transport target', () => {
    const targets = getTargets(buildBasePinoOptions({ LOG_LEVEL: 'warn' }, TERMINAL).transport);

    for (const target of targets) {
      expect(target.level).toBe('warn');
    }
  });

  it('uses the production default level when only NODE_ENV=production is provided', () => {
    const options = buildBasePinoOptions({ NODE_ENV: 'production' });

    expect(options.level).toBe('info');
  });

  it('does NOT inject a pino-opentelemetry-transport target', () => {
    const targets = getTargets(
      buildBasePinoOptions(
        {
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
        },
        TERMINAL,
      ).transport,
    );

    expect(targets.some((t) => t.target === 'pino-opentelemetry-transport')).toBe(false);
  });

  it('does NOT install a mixin (OTel correlation is layered by @bge/otel)', () => {
    const options = buildBasePinoOptions({}, TERMINAL);

    expect(options.mixin).toBeUndefined();
  });

  it('defaults env to process.env when no argument is supplied', () => {
    const originalLogLevel = process.env['LOG_LEVEL'];
    const originalNodeEnv = process.env['NODE_ENV'];

    process.env['LOG_LEVEL'] = 'fatal';
    process.env['NODE_ENV'] = 'production';

    try {
      const options = buildBasePinoOptions();
      expect(options.level).toBe('fatal');
    } finally {
      if (originalLogLevel === undefined) {
        delete process.env['LOG_LEVEL'];
      } else {
        process.env['LOG_LEVEL'] = originalLogLevel;
      }

      if (originalNodeEnv === undefined) {
        delete process.env['NODE_ENV'];
      } else {
        process.env['NODE_ENV'] = originalNodeEnv;
      }
    }
  });
});

describe('credential redaction (#748)', () => {
  type LogRecord = Record<string, any>;

  let server: http.Server;
  let lines: string[];

  const records = (): LogRecord[] =>
    lines
      .join('')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));

  const findRecord = (msg: string): LogRecord => {
    const record = records().find((r) => r['msg'] === msg);
    if (!record) {
      throw new Error(`no log record with msg "${msg}"`);
    }

    return record;
  };

  // pino-http writes the access line when the response finishes, which can
  // land just after the client has read the response.
  const waitForAccessLine = async (): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (records().some((r) => r['msg'] === 'request completed')) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error('the access line was never logged');
  };

  beforeEach(() => {
    const options = optionsWithoutTransport();
    lines = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const httpLogger = pinoHttp({ logger: pino(options, sink) });

    server = http.createServer((req, res) => {
      httpLogger(req, res);
      req.log.info('inside the handler');
      res.setHeader('Set-Cookie', ['bge.session=cookie-secret', 'bge.other=second-secret']);
      res.end();
    });
  });

  afterEach(() => {
    server.close();
  });

  it('logs no authorization, cookie or x-api-key value on the access line, at debug', async () => {
    await request(server).get('/').set(CREDENTIAL_HEADERS);
    await waitForAccessLine();

    const { req } = findRecord('request completed');

    expect(req.headers.authorization).toBe('[Redacted]');
    expect(req.headers.cookie).toBe('[Redacted]');
    expect(req.headers['x-api-key']).toBe('[Redacted]');
    const output = lines.join('');
    expect(output).not.toContain('bearer-secret');
    expect(output).not.toContain('cookie-secret');
    expect(output).not.toContain('key-secret');
  });

  it('logs no set-cookie value, however many cookies the response sets', async () => {
    await request(server).get('/');
    await waitForAccessLine();

    const { res } = findRecord('request completed');

    expect(res.headers['set-cookie']).toBe('[Redacted]');
    expect(lines.join('')).not.toContain('second-secret');
  });

  it('redacts the request on a line the handler logs while the request is handled', async () => {
    await request(server).get('/').set(CREDENTIAL_HEADERS);
    await waitForAccessLine();

    const { req } = findRecord('inside the handler');

    expect(req.headers.authorization).toBe('[Redacted]');
  });

  it('adds no placeholder for a credential the request did not carry', async () => {
    await request(server).get('/');
    await waitForAccessLine();

    const { req } = findRecord('request completed');

    expect(req.headers).not.toHaveProperty('authorization');
    expect(req.headers).not.toHaveProperty('cookie');
    expect(req.headers).not.toHaveProperty('x-api-key');
  });
});

describe('buildRequestSerializer (#935)', () => {
  type LogRecord = { msg?: string; req: { headers: Record<string, unknown>; query?: unknown; url: string } };

  const RETURN_PATH = '/api/users/me/upstream-accounts/steam/return';
  const STEAM_ID = '76561197960287930';
  const QUERY = `openid.claimed_id=https%3A%2F%2Fsteamcommunity.com%2Fopenid%2Fid%2F${STEAM_ID}&state=spent-state`;

  let server: http.Server;
  let lines: string[];

  const accessLine = async (): Promise<LogRecord> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const record = lines
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line): LogRecord => JSON.parse(line))
        .find((r) => r.msg === 'request completed');
      if (record) {
        return record;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error('the access line was never logged');
  };

  beforeEach(() => {
    const options = optionsWithoutTransport();
    lines = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const httpLogger = pinoHttp({
      logger: pino(options, sink),
      serializers: { req: buildRequestSerializer({ pathsWithoutQuery: [RETURN_PATH] }) },
    });

    server = http.createServer((req, res) => {
      // Express sets `query`; the bare http server stands in for it.
      Object.assign(req, { query: Object.fromEntries(new URL(req.url ?? '/', 'http://localhost').searchParams) });
      httpLogger(req, res);
      res.end();
    });
  });

  afterEach(() => {
    server.close();
  });

  it('logs only the path for a listed route, so the SteamID stays out of the logs', async () => {
    await request(server).get(`${RETURN_PATH}?${QUERY}`);

    const { req } = await accessLine();

    expect(req.url).toBe(RETURN_PATH);
    expect(req).not.toHaveProperty('query');
    expect(lines.join('')).not.toContain(STEAM_ID);
    expect(lines.join('')).not.toContain('spent-state');
  });

  it('matches the listed route however Express would, ignoring case and a trailing slash', async () => {
    await request(server).get(`${RETURN_PATH.toUpperCase()}/?${QUERY}`);

    const { req } = await accessLine();

    expect(req.url).toBe(`${RETURN_PATH.toUpperCase()}/`);
    expect(lines.join('')).not.toContain(STEAM_ID);
  });

  // The serializer replaces pino-http's own, so the base options' redaction
  // must still reach the request it returns (#748).
  it('still redacts the credentials on a listed route', async () => {
    await request(server).get(`${RETURN_PATH}?${QUERY}`).set(CREDENTIAL_HEADERS);

    const { req } = await accessLine();

    expect(req.headers['authorization']).toBe('[Redacted]');
    expect(req.headers['cookie']).toBe('[Redacted]');
    expect(req.headers['x-api-key']).toBe('[Redacted]');
    const output = lines.join('');
    expect(output).not.toContain('bearer-secret');
    expect(output).not.toContain('cookie-secret');
    expect(output).not.toContain('key-secret');
  });

  it('logs the full URL and query for any other route', async () => {
    await request(server).get('/api/games?search=catan');

    const { req } = await accessLine();

    expect(req.url).toBe('/api/games?search=catan');
    expect(req.query).toEqual({ search: 'catan' });
  });
});
