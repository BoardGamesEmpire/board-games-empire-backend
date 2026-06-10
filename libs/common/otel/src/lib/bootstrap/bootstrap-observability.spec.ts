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

const childLogger = {
  trace: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

const rootLogger = {
  child: jest.fn(() => childLogger),
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

describe('bootstrapObservability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    rootLogger.child.mockReturnValue(childLogger);
    pinoMock.mockReturnValue(rootLogger);
    initOtelMock.mockReturnValue(mockOtelHandle);
    buildOptionsMock.mockReturnValue({ level: 'info' });
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

  describe('pino bootstrap logger', () => {
    it('constructs pino with the result of buildOtelPinoOptions', () => {
      bootstrapObservability(baseConfig);

      expect(pinoMock).toHaveBeenCalledWith({ level: 'info' });
    });

    it('creates a child logger with service and component bindings', () => {
      bootstrapObservability({ ...baseConfig, serviceName: 'bge-coordinator' });

      expect(rootLogger.child).toHaveBeenCalledWith({
        service: 'bge-coordinator',
        component: 'bootstrap',
      });
    });

    it('returns the child logger as bootstrapLogger', () => {
      const { bootstrapLogger } = bootstrapObservability(baseConfig);

      expect(bootstrapLogger).toBe(childLogger);
    });

    it('emits a startup info log with service identity', () => {
      bootstrapObservability(baseConfig);

      expect(childLogger.info).toHaveBeenCalledWith(
        { serviceName: 'bge-test', serviceVersion: '1.2.3' },
        'OpenTelemetry SDK initialized',
      );
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
    it('installs a diag logger at INFO level', () => {
      bootstrapObservability(baseConfig);

      expect(diagSetLoggerMock).toHaveBeenCalledTimes(1);
      const [, level] = diagSetLoggerMock.mock.calls[0];
      expect(level).toBe(DiagLogLevel.INFO);
    });

    it('routes diag.info through the bootstrap pino at info level', () => {
      bootstrapObservability(baseConfig);

      const [installedLogger] = diagSetLoggerMock.mock.calls[0];
      installedLogger.info('sdk message', 'arg1', 'arg2');

      expect(childLogger.info).toHaveBeenCalledWith({ otel: ['arg1', 'arg2'] }, 'sdk message');
    });

    it('routes diag.warn through the bootstrap pino at warn level', () => {
      bootstrapObservability(baseConfig);

      const [installedLogger] = diagSetLoggerMock.mock.calls[0];
      installedLogger.warn('exporter retry');

      expect(childLogger.warn).toHaveBeenCalledWith({ otel: [] }, 'exporter retry');
    });

    it('routes diag.error through the bootstrap pino at error level', () => {
      bootstrapObservability(baseConfig);

      const [installedLogger] = diagSetLoggerMock.mock.calls[0];
      installedLogger.error('failed to flush');

      expect(childLogger.error).toHaveBeenCalledWith({ otel: [] }, 'failed to flush');
    });

    it('routes diag.verbose through the bootstrap pino at trace level', () => {
      bootstrapObservability(baseConfig);

      const [installedLogger] = diagSetLoggerMock.mock.calls[0];
      installedLogger.verbose('span queued');

      expect(childLogger.trace).toHaveBeenCalledWith({ otel: [] }, 'span queued');
    });

    it('routes diag.debug through the bootstrap pino at debug level', () => {
      bootstrapObservability(baseConfig);

      const [installedLogger] = diagSetLoggerMock.mock.calls[0];
      installedLogger.debug('instrumentation patched');

      expect(childLogger.debug).toHaveBeenCalledWith({ otel: [] }, 'instrumentation patched');
    });
  });
});
