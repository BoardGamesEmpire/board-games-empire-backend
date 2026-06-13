import type { Logger as PinoInstance } from 'pino';
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

const internalBootstrapChild = {
  trace: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

const baseLogger = {
  trace: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn(() => internalBootstrapChild),
};

jest.mock('@bge/logger', () => ({
  bootstrapLogging: jest.fn(() => baseLogger),
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

import { bootstrapLogging } from '@bge/logger';
import { diag, DiagLogLevel } from '@opentelemetry/api';
import { OTEL_LOG_LEVEL_ENV } from '../init/diag-log-level';
import { initOtel } from '../init/init-otel';
import { buildOtelPinoOptions } from '../pino/otel-pino.options';
import { bootstrapObservability } from './bootstrap-observability';

const initOtelMock = initOtel as jest.Mock;
const buildOptionsMock = buildOtelPinoOptions as jest.Mock;
const bootstrapLoggingMock = bootstrapLogging as jest.Mock;
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
    baseLogger.child.mockReturnValue(internalBootstrapChild);
    bootstrapLoggingMock.mockReturnValue(baseLogger);
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
    it('builds pino options before constructing the base logger', () => {
      bootstrapObservability(baseConfig);

      const buildOptionsOrder = buildOptionsMock.mock.invocationCallOrder[0];
      const bootstrapLoggingOrder = bootstrapLoggingMock.mock.invocationCallOrder[0];
      expect(buildOptionsOrder).toBeLessThan(bootstrapLoggingOrder);
    });

    it('constructs the base logger before initializing the SDK', () => {
      bootstrapObservability(baseConfig);

      const bootstrapLoggingOrder = bootstrapLoggingMock.mock.invocationCallOrder[0];
      const initOtelOrder = initOtelMock.mock.invocationCallOrder[0];
      expect(bootstrapLoggingOrder).toBeLessThan(initOtelOrder);
    });

    it('initializes the SDK before installing the diag logger', () => {
      bootstrapObservability(baseConfig);

      const initOtelOrder = initOtelMock.mock.invocationCallOrder[0];
      const diagOrder = diagSetLoggerMock.mock.invocationCallOrder[0];
      expect(initOtelOrder).toBeLessThan(diagOrder);
    });
  });

  describe('base logger construction', () => {
    it('delegates to bootstrapLogging from @bge/logger', () => {
      bootstrapObservability(baseConfig);

      expect(bootstrapLoggingMock).toHaveBeenCalledTimes(1);
    });

    it('forwards the configured serviceName to bootstrapLogging', () => {
      bootstrapObservability({ ...baseConfig, serviceName: 'bge-coordinator' });

      expect(bootstrapLoggingMock).toHaveBeenCalledWith(
        { serviceName: 'bge-coordinator' },
        expect.objectContaining({ level: 'info' }),
      );
    });

    it('passes the result of buildOtelPinoOptions as the options argument', () => {
      bootstrapObservability(baseConfig);

      expect(bootstrapLoggingMock).toHaveBeenCalledWith(expect.any(Object), { level: 'info' });
    });

    it('returns the bootstrapLogging result as baseLogger', () => {
      const result = bootstrapObservability(baseConfig);

      expect(result.baseLogger).toBe(baseLogger as unknown as PinoInstance);
    });

    it('does not expose the internal bootstrap child on the return value', () => {
      const result = bootstrapObservability(baseConfig);

      expect(Object.keys(result)).toEqual(expect.arrayContaining(['otel', 'baseLogger']));
      expect(Object.keys(result)).not.toEqual(expect.arrayContaining(['bootstrapLogger']));
    });
  });

  describe('internal bootstrap child', () => {
    it('derives the bootstrap child from the base logger with the component binding', () => {
      bootstrapObservability(baseConfig);

      expect(baseLogger.child).toHaveBeenCalledTimes(1);
      expect(baseLogger.child).toHaveBeenCalledWith({ component: 'bootstrap' });
    });

    it('emits the startup info log through the internal bootstrap child (not the base)', () => {
      bootstrapObservability(baseConfig);

      expect(internalBootstrapChild.info).toHaveBeenCalledWith(
        { serviceName: 'bge-test', serviceVersion: '1.2.3' },
        'OpenTelemetry SDK initialized',
      );
      expect(baseLogger.info).not.toHaveBeenCalled();
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

    it('routes diag.info through the internal bootstrap pino at info level', () => {
      bootstrapObservability(baseConfig);

      const [installedLogger] = diagSetLoggerMock.mock.calls[0];
      installedLogger.info('sdk message', 'arg1', 'arg2');

      expect(internalBootstrapChild.info).toHaveBeenCalledWith({ otel: ['arg1', 'arg2'] }, 'sdk message');
    });

    it('routes diag.warn through the internal bootstrap pino at warn level', () => {
      bootstrapObservability(baseConfig);

      const [installedLogger] = diagSetLoggerMock.mock.calls[0];
      installedLogger.warn('exporter retry');

      expect(internalBootstrapChild.warn).toHaveBeenCalledWith({ otel: [] }, 'exporter retry');
    });

    it('routes diag.error through the internal bootstrap pino at error level', () => {
      bootstrapObservability(baseConfig);

      const [installedLogger] = diagSetLoggerMock.mock.calls[0];
      installedLogger.error('failed to flush');

      expect(internalBootstrapChild.error).toHaveBeenCalledWith({ otel: [] }, 'failed to flush');
    });

    it('routes diag.verbose through the internal bootstrap pino at trace level', () => {
      bootstrapObservability(baseConfig);

      const [installedLogger] = diagSetLoggerMock.mock.calls[0];
      installedLogger.verbose('span queued');

      expect(internalBootstrapChild.trace).toHaveBeenCalledWith({ otel: [] }, 'span queued');
    });

    it('routes diag.debug through the internal bootstrap pino at debug level', () => {
      bootstrapObservability(baseConfig);

      const [installedLogger] = diagSetLoggerMock.mock.calls[0];
      installedLogger.debug('instrumentation patched');

      expect(internalBootstrapChild.debug).toHaveBeenCalledWith({ otel: [] }, 'instrumentation patched');
    });
  });
});
