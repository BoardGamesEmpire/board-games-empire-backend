import http from 'node:http';
import { Writable } from 'node:stream';
import pino, { type TransportTargetOptions } from 'pino';
import pinoHttp from 'pino-http';
import request from 'supertest';
import { buildBasePinoOptions, resolvePinoLevel, type LogDestination } from './base-pino.options';

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

  const CREDENTIAL_HEADERS = {
    Authorization: 'Bearer bearer-secret',
    Cookie: 'bge.session=cookie-secret',
    'X-API-Key': 'key-secret',
  };

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
    // Strip the transport: pino refuses a destination stream alongside one.
    const { transport: _transport, ...options } = buildBasePinoOptions({ LOG_LEVEL: 'debug' });
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
