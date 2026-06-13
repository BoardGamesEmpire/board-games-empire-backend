import type { TransportTargetOptions } from 'pino';
import { buildBasePinoOptions, resolvePinoLevel } from './base-pino.options';

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
    const options = buildBasePinoOptions({});

    expect(getTargets(options.transport)).toHaveLength(1);
  });

  it('configures pino-pretty as the sole default target', () => {
    const targets = getTargets(buildBasePinoOptions({}).transport);

    expect(targets).toHaveLength(1);
    expect(targets[0].target).toBe('pino-pretty');
  });

  it('configures pino-pretty with colorize and singleLine', () => {
    const [target] = getTargets(buildBasePinoOptions({}).transport);

    expect(target.options).toEqual({ colorize: true, singleLine: true });
  });

  it('applies the resolved level to the top-level options', () => {
    const options = buildBasePinoOptions({ LOG_LEVEL: 'warn' });

    expect(options.level).toBe('warn');
  });

  it('applies the resolved level to every transport target', () => {
    const targets = getTargets(buildBasePinoOptions({ LOG_LEVEL: 'warn' }).transport);

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
      buildBasePinoOptions({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      }).transport,
    );

    expect(targets.some((t) => t.target === 'pino-opentelemetry-transport')).toBe(false);
  });

  it('does NOT install a mixin (OTel correlation is layered by @bge/otel)', () => {
    const options = buildBasePinoOptions({});

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
