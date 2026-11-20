import { emitAfterCommit } from './emit-after-commit.util';

describe('emitAfterCommit (#245)', () => {
  const setup = () => ({
    emitter: { emit: jest.fn().mockReturnValue(true) },
    logger: { error: jest.fn() },
  });

  it('emits the payload under its name and logs nothing', () => {
    const { emitter, logger } = setup();
    const payload = { id: 'hh-1' };

    emitAfterCommit(emitter, logger, 'household.updated', payload, 'Household hh-1');

    expect(emitter.emit).toHaveBeenCalledWith('household.updated', payload);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs a throwing listener as (message, stack) and does not rethrow', () => {
    // The change has committed. A throw out of `emit()` would turn it into a
    // 500, and nestjs-pino drops an `Error` passed as a bare argument.
    const { emitter, logger } = setup();
    const failure = new Error('audit listener exploded');
    emitter.emit.mockImplementation(() => {
      throw failure;
    });

    expect(() => emitAfterCommit(emitter, logger, 'household.updated', {}, 'Household hh-1')).not.toThrow();

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message, stack] = logger.error.mock.calls[0] as [string, unknown];
    expect(message).toBe(
      'A listener failed for household.updated (Household hh-1) after the change committed: audit listener exploded',
    );
    expect(stack).toBe(failure.stack);
  });

  it('logs a non-Error throw by its string form, with no stack argument', () => {
    const { emitter, logger } = setup();
    emitter.emit.mockImplementation(() => {
      throw 'boom';
    });

    expect(() => emitAfterCommit(emitter, logger, 'household.updated', {}, 'Household hh-1')).not.toThrow();

    expect(logger.error.mock.calls).toEqual([
      ['A listener failed for household.updated (Household hh-1) after the change committed: boom'],
    ]);
  });
});
