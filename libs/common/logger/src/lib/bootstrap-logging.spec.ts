import type { LoggerOptions, Logger as PinoInstance } from 'pino';

const childLogger = {
  trace: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
};

const rootLogger = {
  child: jest.fn((): typeof childLogger => childLogger),
};

jest.mock('pino', () => ({
  __esModule: true,
  default: jest.fn((): typeof rootLogger => rootLogger),
}));

jest.mock('./base-pino.options', () => ({
  buildBasePinoOptions: jest.fn((): LoggerOptions => ({ level: 'silent' })),
}));

import pino from 'pino';
import { buildBasePinoOptions } from './base-pino.options';
import { bootstrapLogging } from './bootstrap-logging';

const pinoMock = pino as unknown as jest.Mock;
const buildBasePinoOptionsMock = buildBasePinoOptions as jest.Mock;

describe('bootstrapLogging', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pinoMock.mockReturnValue(rootLogger);
    rootLogger.child.mockReturnValue(childLogger);
    buildBasePinoOptionsMock.mockReturnValue({ level: 'silent' });
  });

  describe('with default options', () => {
    it('calls buildBasePinoOptions to source defaults', () => {
      bootstrapLogging({ serviceName: 'bge-test' });

      expect(buildBasePinoOptionsMock).toHaveBeenCalledTimes(1);
    });

    it('passes the resolved default options to pino', () => {
      const defaults: LoggerOptions = { level: 'silent' };
      buildBasePinoOptionsMock.mockReturnValueOnce(defaults);

      bootstrapLogging({ serviceName: 'bge-test' });

      expect(pinoMock).toHaveBeenCalledWith(defaults);
    });
  });

  describe('with explicit options', () => {
    it('does NOT call buildBasePinoOptions when options are supplied', () => {
      bootstrapLogging({ serviceName: 'bge-test' }, { level: 'info' });

      expect(buildBasePinoOptionsMock).not.toHaveBeenCalled();
    });

    it('passes the supplied options straight through to pino', () => {
      const customOptions: LoggerOptions = { level: 'warn', name: 'custom' };

      bootstrapLogging({ serviceName: 'bge-test' }, customOptions);

      expect(pinoMock).toHaveBeenCalledWith(customOptions);
    });
  });

  describe('service binding', () => {
    it('binds the configured serviceName on the returned child', () => {
      bootstrapLogging({ serviceName: 'bge-api' });

      expect(rootLogger.child).toHaveBeenCalledWith({ service: 'bge-api' });
    });

    it('creates exactly one child off the root logger', () => {
      bootstrapLogging({ serviceName: 'bge-api' });

      expect(rootLogger.child).toHaveBeenCalledTimes(1);
    });

    it('returns the service-bound child logger (not the root)', () => {
      const result: PinoInstance = bootstrapLogging({ serviceName: 'bge-api' });

      expect(result).toBe(childLogger);
      expect(result).not.toBe(rootLogger);
    });

    it('uses the serviceName from the supplied config, not a hardcoded value', () => {
      bootstrapLogging({ serviceName: 'bge-gateway-bgg' });

      expect(rootLogger.child).toHaveBeenCalledWith({ service: 'bge-gateway-bgg' });
    });
  });
});
