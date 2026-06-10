import type { OtelBootstrapHandle } from '../init/init-otel';
import type { OtelInitConfig } from '../init/otel.config';
import { noopActorContextProvider } from '../processors/actor-context-provider';

// jest.mock factories hoist above imports. Order is intentional.

const mockOtelHandle: OtelBootstrapHandle = {
  sdk: {} as never,
  shutdown: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../init/init-otel', () => ({
  initOtel: jest.fn(() => mockOtelHandle),
}));

jest.mock('../pino/otel-pino.options', () => ({
  buildOtelPinoOptions: jest.fn(() => ({ level: 'info' })),
}));

const bootstrapChildLogger = {
  trace: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

const baseChildLogger = {
  trace: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn(() => bootstrapChildLogger),
};

const rootLogger = {
  child: jest.fn(() => baseChildLogger),
};

jest.mock('pino', () => ({
  __esModule: true,
  default: jest.fn(() => rootLogger),
}));

jest.mock('@opentelemetry/api', () => {
  const actual = jest.requireActual<typeof import('@opentelemetry/api')>('@opentelemetry/api');
  return {
    ...actual,
    diag: {
      ...actual.diag,
      setLogger: jest.fn(),
    },
  };
});

import { diag, DiagLogLevel } from '@opentelemetry/api';
import pino from 'pino';
import { OTEL_LOG_LEVEL_ENV } from '../init/diag-log-level';
import { initOtel } from '../init/init-otel';
import { buildOtelPinoOptions } from '../pino/otel-pino.options';
import { bootstrapObservability } from './bootstrap-observability';

const initOtelMock = initOtel as jest.Mock;
const buildOptionsMock = buildOtelPinoOptions as jest.Mock;
const pinoMock = pino as unknown as jest.Mock;
const diagSetLoggerMock = diag.setLogger as jest.Mock;

const baseConfig: OtelInitConfig = {
  serviceName: 'bge-test',
  serviceVersion: '1.2.3',
  actorContextProvider: noopActorContextProvider,
};

const restoreEnvVar = (name: string, original: string | undefined): void => {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
};

describe('bootstrapObservability', () => {
  let originalLogLevel: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    baseChildLogger.child.mockReturnValue(bootstrapChildLogger);
    rootLogger.child.mockReturnValue(baseChildLogger);
    pinoMock.mockReturnValue(rootLogger);
    initOtelMock.mockReturnValue(mockOtelHandle);
    buildOptionsMock.mockReturnValue({ level: 'info' });

    // Snapshot OTEL_LOG_LEVEL — diag-bridge tests mutate it.
    originalLogLevel = process.env[OTEL_LOG_LEVEL_ENV];
    delete process.env[OTEL_LOG_LEVEL_ENV];
  });

  afterEach(() => {
    restoreEnvVar(OTEL_LOG_LEVEL_ENV, originalLogLevel);
  });

  describe('initialization order', () => {
    it('builds pino options before initializing the SDK', () => {
      bootstrapObservability(baseConfig);

      const buildOptionsOrder = buildOptionsMock.mock.invocationCallOrder[0];
      const initOtelOrder = initOtelMock.mock.invocationCallOrder[0];
      expect(buildOptionsOrder).toBeLessThan(initOtelOrder);
    });

    it('initializes the SDK before installing the diag logger', () => {
      bootstrapObservability(baseConfig);

      const initOtelOrder = initOtelMock.mock.invocationCallOrder[0];
      const diagOrder = diagSetLoggerMock.mock.invocationCallOrder[0];
      expect(initOtelOrder).toBeLessThan(diagOrder);
    });
  });

  describe('pino loggers', () => {
    it('constructs pino with the result of buildOtelPinoOptions', () => {
      bootstrapObservability(baseConfig);

      expect(pinoMock).toHaveBeenCalledWith({ level: 'info' });
    });

    it('creates the base logger with only the service binding', () => {
      bootstrapObservability({ ...baseConfig, serviceName: 'bge-coordinator' });

      expect(rootLogger.child).toHaveBeenCalledTimes(1);
      expect(rootLogger.child).toHaveBeenCalledWith({
        service: 'bge-coordinator',
      });
    });

    it('creates the bootstrap logger as a child of the base with the component binding', () => {
      bootstrapObservability(baseConfig);

      expect(baseChildLogger.child).toHaveBeenCalledTimes(1);
      expect(baseChildLogger.child).toHaveBeenCalledWith({
        component: 'bootstrap',
      });
    });

    it('returns the base child as baseLogger', () => {
      const { baseLogger } = bootstrapObservability(baseConfig);

      expect(baseLogger).toBe(baseChildLogger);
    });

    it('returns the bootstrap child as bootstrapLogger', () => {
      const { bootstrapLogger } = bootstrapObservability(baseConfig);

      expect(bootstrapLogger).toBe(bootstrapChildLogger);
    });

    it('emits the startup info log through the bootstrap logger (not the base)', () => {
      bootstrapObservability(baseConfig);

      expect(bootstrapChildLogger.info).toHaveBeenCalledWith(
        { serviceName: 'bge-test', serviceVersion: '1.2.3' },
        'OpenTelemetry SDK initialized',
      );
      expect(baseChildLogger.info).not.toHaveBeenCalled();
    });
  });

  describe('OTel handle', () => {
    it('passes the config straight through to initOtel', () => {
      bootstrapObservability(baseConfig);

      expect(initOtelMock).toHaveBeenCalledWith(baseConfig);
    });

    it('returns the handle from initOtel', () => {
      const { otel } = bootstrapObservability(baseConfig);

      expect(otel).toBe(mockOtelHandle);
    });
  });

  describe('diag bridge', () => {
    it('installs a diag logger at INFO level when OTEL_LOG_LEVEL is unset', () => {
      bootstrapObservability(baseConfig);

      expect(diagSetLoggerMock).toHaveBeenCalledTimes(1);
      const [, level] = diagSetLoggerMock.mock.calls[0];
      expect(level).toBe(DiagLogLevel.INFO);
    });

    it('honors OTEL_LOG_LEVEL=debug', () => {
      process.env[OTEL_LOG_LEVEL_ENV] = 'debug';

      bootstrapObservability(baseConfig);

      const [, level] = diagSetLoggerMock.mock.calls[0];
      expect(level).toBe(DiagLogLevel.DEBUG);
    });

    it('honors OTEL_LOG_LEVEL=verbose', () => {
      process.env[OTEL_LOG_LEVEL_ENV] = 'verbose';

      bootstrapObservability(baseConfig);

      const [, level] = diagSetLoggerMock.mock.calls[0];
      expect(level).toBe(DiagLogLevel.VERBOSE);
    });

    it('honors OTEL_LOG_LEVEL=error', () => {
      process.env[OTEL_LOG_LEVEL_ENV] = 'error';

      bootstrapObservability(baseConfig);

      const [, level] = diagSetLoggerMock.mock.calls[0];
      expect(level).toBe(DiagLogLevel.ERROR);
    });

    it('falls back to INFO when OTEL_LOG_LEVEL is an unrecognized value', () => {
      process.env[OTEL_LOG_LEVEL_ENV] = 'verbsoe';

      bootstrapObservability(baseConfig);

      const [, level] = diagSetLoggerMock.mock.calls[0];
      expect(level).toBe(DiagLogLevel.INFO);
    });

    it('routes diag.info through the bootstrap pino at info level', () => {
      bootstrapObservability(baseConfig);

      const [installedLogger] = diagSetLoggerMock.mock.calls[0];
      installedLogger.info('sdk message', 'arg1', 'arg2');

      expect(bootstrapChildLogger.info).toHaveBeenCalledWith({ otel: ['arg1', 'arg2'] }, 'sdk message');
    });

    it('routes diag.warn through the bootstrap pino at warn level', () => {
      bootstrapObservability(baseConfig);

      const [installedLogger] = diagSetLoggerMock.mock.calls[0];
      installedLogger.warn('exporter retry');

      expect(bootstrapChildLogger.warn).toHaveBeenCalledWith({ otel: [] }, 'exporter retry');
    });

    it('routes diag.error through the bootstrap pino at error level', () => {
      bootstrapObservability(baseConfig);

      const [installedLogger] = diagSetLoggerMock.mock.calls[0];
      installedLogger.error('failed to flush');

      expect(bootstrapChildLogger.error).toHaveBeenCalledWith({ otel: [] }, 'failed to flush');
    });

    it('routes diag.verbose through the bootstrap pino at trace level', () => {
      bootstrapObservability(baseConfig);

      const [installedLogger] = diagSetLoggerMock.mock.calls[0];
      installedLogger.verbose('span queued');

      expect(bootstrapChildLogger.trace).toHaveBeenCalledWith({ otel: [] }, 'span queued');
    });

    it('routes diag.debug through the bootstrap pino at debug level', () => {
      bootstrapObservability(baseConfig);

      const [installedLogger] = diagSetLoggerMock.mock.calls[0];
      installedLogger.debug('instrumentation patched');

      expect(bootstrapChildLogger.debug).toHaveBeenCalledWith({ otel: [] }, 'instrumentation patched');
    });
  });
});
