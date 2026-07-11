import { guardWorkerEvent } from './worker-event.js';

describe('guardWorkerEvent', () => {
  const makeLogger = () => ({ error: jest.fn() });

  it('runs the handler and does not log when it resolves', async () => {
    const logger = makeLogger();
    const handler = jest.fn().mockResolvedValue(undefined);

    await guardWorkerEvent(logger, 'ctx', handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('swallows a rejecting handler so the caller never rejects', async () => {
    const logger = makeLogger();
    const error = new Error('boom');

    // Must resolve, not reject — a rejection here is exactly what would crash
    // the worker via BullMQ's raw event listener.
    await expect(
      guardWorkerEvent(logger, 'terminal bookkeeping', () => Promise.reject(error)),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message, stack] = logger.error.mock.calls[0];
    expect(message).toContain('terminal bookkeeping');
    expect(stack).toBe(error.stack);
  });

  it('stringifies a non-Error rejection for the log stack', async () => {
    const logger = makeLogger();

    await expect(guardWorkerEvent(logger, 'ctx', () => Promise.reject('plain string'))).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('ctx'), 'plain string');
  });
});
