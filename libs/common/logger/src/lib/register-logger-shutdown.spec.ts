import type { Logger as PinoInstance } from 'pino';
import { createLoggerShutdown, registerLoggerShutdown, type ShutdownableApp } from './register-logger-shutdown';

interface MockLogger {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  flush: jest.Mock;
}

type FlushCallback = (err?: Error) => void;

const buildMockLogger = (flushImpl?: (cb: FlushCallback) => void): MockLogger => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  flush: jest.fn(
    flushImpl ??
      ((cb: FlushCallback): void => {
        cb();
      }),
  ),
});

const buildMockApp = (closeImpl?: () => Promise<void>): jest.Mocked<ShutdownableApp> => ({
  close: jest.fn(closeImpl ?? (() => Promise.resolve())) as jest.Mock,
});

describe('createLoggerShutdown', () => {
  describe('happy path', () => {
    it('closes the Nest app before flushing the logger', async () => {
      const order: string[] = [];
      const app = buildMockApp(async () => {
        order.push('app');
      });
      const logger = buildMockLogger((cb: FlushCallback) => {
        order.push('flush');
        cb();
      });

      const shutdown = createLoggerShutdown(app, logger as unknown as PinoInstance);
      await shutdown('SIGTERM');

      expect(order).toEqual(['app', 'flush']);
    });

    it('logs a "shutting down" info with the signal', async () => {
      const app = buildMockApp();
      const logger = buildMockLogger();

      const shutdown = createLoggerShutdown(app, logger as unknown as PinoInstance);
      await shutdown('SIGINT');

      expect(logger.info).toHaveBeenCalledWith({ signal: 'SIGINT' }, 'shutting down');
    });

    it('invokes pino flush exactly once', async () => {
      const app = buildMockApp();
      const logger = buildMockLogger();

      const shutdown = createLoggerShutdown(app, logger as unknown as PinoInstance);
      await shutdown('SIGTERM');

      expect(logger.flush).toHaveBeenCalledTimes(1);
    });
  });

  describe('error isolation', () => {
    it('continues to flush when app.close throws', async () => {
      const closeError = new Error('close exploded');
      const app = buildMockApp(() => Promise.reject(closeError));
      const logger = buildMockLogger();

      const shutdown = createLoggerShutdown(app, logger as unknown as PinoInstance);
      await shutdown('SIGTERM');

      expect(logger.flush).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith({ err: closeError }, 'NestJS app.close() failed');
    });

    it('logs but does not throw when flush callback yields an error', async () => {
      const flushError = new Error('flush exploded');
      const app = buildMockApp();
      const logger = buildMockLogger((cb: FlushCallback) => {
        cb(flushError);
      });

      const shutdown = createLoggerShutdown(app, logger as unknown as PinoInstance);

      await expect(shutdown('SIGTERM')).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith({ err: flushError }, 'pino logger flush failed');
    });

    it('still attempts flush when both close and flush fail', async () => {
      const app = buildMockApp(() => Promise.reject(new Error('a')));
      const logger = buildMockLogger((cb: FlushCallback) => {
        cb(new Error('b'));
      });

      const shutdown = createLoggerShutdown(app, logger as unknown as PinoInstance);
      await shutdown('SIGTERM');

      expect(app.close).toHaveBeenCalledTimes(1);
      expect(logger.flush).toHaveBeenCalledTimes(1);
    });
  });

  describe('re-entrancy', () => {
    it('returns the in-flight promise on a second call before the first resolves', async () => {
      let resolveClose!: () => void;
      const closePromise = new Promise<void>((resolve) => {
        resolveClose = resolve;
      });
      const app = buildMockApp(() => closePromise);
      const logger = buildMockLogger();

      const shutdown = createLoggerShutdown(app, logger as unknown as PinoInstance);
      const first = shutdown('SIGTERM');
      const second = shutdown('SIGINT');

      expect(second).toBe(first);
      expect(logger.warn).toHaveBeenCalledWith({ signal: 'SIGINT' }, 'shutdown already in progress, ignoring signal');

      resolveClose();
      await first;
    });

    it('does not call app.close or flush twice on re-entry', async () => {
      const app = buildMockApp();
      const logger = buildMockLogger();

      const shutdown = createLoggerShutdown(app, logger as unknown as PinoInstance);

      const first = shutdown('SIGTERM');
      const second = shutdown('SIGTERM');
      await Promise.all([first, second]);

      expect(app.close).toHaveBeenCalledTimes(1);
      expect(logger.flush).toHaveBeenCalledTimes(1);
    });
  });
});

describe('registerLoggerShutdown', () => {
  let onceSpy: jest.SpyInstance;

  beforeEach(() => {
    onceSpy = jest.spyOn(process, 'once').mockImplementation(((..._args: unknown[]) => process) as never);
  });

  afterEach(() => {
    onceSpy.mockRestore();
  });

  it('registers a once handler for SIGTERM and SIGINT', () => {
    const app = buildMockApp();
    const logger = buildMockLogger();

    registerLoggerShutdown(app, logger as unknown as PinoInstance);

    const registeredSignals = onceSpy.mock.calls.map(([signal]) => signal);
    expect(registeredSignals).toEqual(expect.arrayContaining(['SIGTERM', 'SIGINT']));
    expect(onceSpy).toHaveBeenCalledTimes(2);
  });

  it('attaches a function as the signal handler for each registered signal', () => {
    const app = buildMockApp();
    const logger = buildMockLogger();

    registerLoggerShutdown(app, logger as unknown as PinoInstance);

    for (const [, handler] of onceSpy.mock.calls) {
      expect(typeof handler).toBe('function');
    }
  });

  it('invokes the shutdown sequence and exits when a registered handler fires', async () => {
    const exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(((..._args: unknown[]) => undefined as never) as never);

    try {
      const app = buildMockApp();
      const logger = buildMockLogger();

      registerLoggerShutdown(app, logger as unknown as PinoInstance);
      const [, handler] = onceSpy.mock.calls.find(([signal]) => signal === 'SIGTERM') ?? [];

      (handler as (signal: NodeJS.Signals) => void)?.('SIGTERM');
      // Wait for the void Promise chain to settle.
      await new Promise((resolve) => setImmediate(resolve));

      expect(app.close).toHaveBeenCalledTimes(1);
      expect(logger.flush).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
