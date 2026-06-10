import type { Logger as PinoInstance } from 'pino';
import type { OtelBootstrapHandle } from '../init/init-otel';
import { createShutdown, registerShutdownHandlers, type ShutdownableApp } from './register-shutdown';

interface MockLogger {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
}

const buildMockLogger = (): MockLogger => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

const buildMockApp = (closeImpl?: () => Promise<void>): jest.Mocked<ShutdownableApp> => ({
  close: jest.fn(closeImpl ?? (() => Promise.resolve())) as jest.Mock,
});

const buildMockOtelHandle = (shutdownImpl?: () => Promise<void>): jest.Mocked<OtelBootstrapHandle> => ({
  sdk: {} as never,
  shutdown: jest.fn(shutdownImpl ?? (() => Promise.resolve())) as jest.Mock,
});

describe('createShutdown', () => {
  describe('happy path', () => {
    it('closes the Nest app before shutting down OTel', async () => {
      const closeCalls: string[] = [];
      const app = buildMockApp(async () => {
        closeCalls.push('app');
      });
      const otelHandle = buildMockOtelHandle(async () => {
        closeCalls.push('otel');
      });
      const logger = buildMockLogger();

      const shutdown = createShutdown(app, otelHandle, logger as unknown as PinoInstance);
      await shutdown('SIGTERM');

      expect(closeCalls).toEqual(['app', 'otel']);
    });

    it('logs a "shutting down" info with the signal', async () => {
      const app = buildMockApp();
      const otelHandle = buildMockOtelHandle();
      const logger = buildMockLogger();

      const shutdown = createShutdown(app, otelHandle, logger as unknown as PinoInstance);
      await shutdown('SIGINT');

      expect(logger.info).toHaveBeenCalledWith({ signal: 'SIGINT' }, 'shutting down');
    });
  });

  describe('error isolation', () => {
    it('continues to OTel shutdown when app.close throws', async () => {
      const closeError = new Error('close exploded');
      const app = buildMockApp(() => Promise.reject(closeError));
      const otelHandle = buildMockOtelHandle();
      const logger = buildMockLogger();

      const shutdown = createShutdown(app, otelHandle, logger as unknown as PinoInstance);
      await shutdown('SIGTERM');

      expect(otelHandle.shutdown).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith({ err: closeError }, 'NestJS app.close() failed');
    });

    it('logs but does not throw when otel.shutdown rejects', async () => {
      const otelError = new Error('flush exploded');
      const app = buildMockApp();
      const otelHandle = buildMockOtelHandle(() => Promise.reject(otelError));
      const logger = buildMockLogger();

      const shutdown = createShutdown(app, otelHandle, logger as unknown as PinoInstance);

      await expect(shutdown('SIGTERM')).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith({ err: otelError }, 'OTel SDK shutdown failed');
    });

    it('still calls otel.shutdown even when both fail', async () => {
      const app = buildMockApp(() => Promise.reject(new Error('a')));
      const otelHandle = buildMockOtelHandle(() => Promise.reject(new Error('b')));
      const logger = buildMockLogger();

      const shutdown = createShutdown(app, otelHandle, logger as unknown as PinoInstance);
      await shutdown('SIGTERM');

      expect(app.close).toHaveBeenCalledTimes(1);
      expect(otelHandle.shutdown).toHaveBeenCalledTimes(1);
    });
  });

  describe('re-entrancy', () => {
    it('returns the in-flight promise on a second call before the first resolves', async () => {
      let resolveClose!: () => void;
      const closePromise = new Promise<void>((resolve) => {
        resolveClose = resolve;
      });
      const app = buildMockApp(() => closePromise);
      const otelHandle = buildMockOtelHandle();
      const logger = buildMockLogger();

      const shutdown = createShutdown(app, otelHandle, logger as unknown as PinoInstance);
      const first = shutdown('SIGTERM');
      const second = shutdown('SIGINT');

      expect(second).toBe(first);
      expect(logger.warn).toHaveBeenCalledWith({ signal: 'SIGINT' }, 'shutdown already in progress, ignoring signal');

      resolveClose();
      await first;
    });

    it('does not call app.close or otel.shutdown twice on re-entry', async () => {
      const app = buildMockApp();
      const otelHandle = buildMockOtelHandle();
      const logger = buildMockLogger();

      const shutdown = createShutdown(app, otelHandle, logger as unknown as PinoInstance);

      const first = shutdown('SIGTERM');
      const second = shutdown('SIGTERM');
      await Promise.all([first, second]);

      expect(app.close).toHaveBeenCalledTimes(1);
      expect(otelHandle.shutdown).toHaveBeenCalledTimes(1);
    });
  });
});

describe('registerShutdownHandlers', () => {
  let onceSpy: jest.SpyInstance;

  beforeEach(() => {
    onceSpy = jest.spyOn(process, 'once').mockImplementation(((..._args: unknown[]) => process) as never);
  });

  afterEach(() => {
    onceSpy.mockRestore();
  });

  it('registers a once handler for SIGTERM and SIGINT', () => {
    const app = buildMockApp();
    const otelHandle = buildMockOtelHandle();
    const logger = buildMockLogger();

    registerShutdownHandlers(app, otelHandle, logger as unknown as PinoInstance);

    const registeredSignals = onceSpy.mock.calls.map(([signal]) => signal);
    expect(registeredSignals).toEqual(expect.arrayContaining(['SIGTERM', 'SIGINT']));
    expect(onceSpy).toHaveBeenCalledTimes(2);
  });

  it('attaches a function as the signal handler for each registered signal', () => {
    const app = buildMockApp();
    const otelHandle = buildMockOtelHandle();
    const logger = buildMockLogger();

    registerShutdownHandlers(app, otelHandle, logger as unknown as PinoInstance);

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
      const otelHandle = buildMockOtelHandle();
      const logger = buildMockLogger();

      registerShutdownHandlers(app, otelHandle, logger as unknown as PinoInstance);
      const [, handler] = onceSpy.mock.calls.find(([signal]) => signal === 'SIGTERM') ?? [];

      handler?.('SIGTERM');
      // Wait for the void Promise chain to settle.
      await new Promise((resolve) => setImmediate(resolve));

      expect(app.close).toHaveBeenCalledTimes(1);
      expect(otelHandle.shutdown).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
