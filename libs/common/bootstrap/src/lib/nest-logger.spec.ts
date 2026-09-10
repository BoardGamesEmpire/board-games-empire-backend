import { nestLoggerFromPino, type PinoLike } from './nest-logger';

// The boot sequence logs through a Nest `Logger` inside its own application
// context; `main.ts` owns a pino instance. This adapter is the bridge, and
// what it must preserve is the context and the structured summary fields.

function recorder(): PinoLike & { calls: { level: string; obj: unknown; msg: string | undefined }[] } {
  const calls: { level: string; obj: unknown; msg: string | undefined }[] = [];
  const at = (level: string) => (obj: unknown, msg?: string) => void calls.push({ level, obj, msg });
  return {
    calls,
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
  };
}

describe('nestLoggerFromPino', () => {
  it('maps Nest levels onto pino levels and carries the Nest context as a field', () => {
    const pino = recorder();
    const logger = nestLoggerFromPino(pino);

    logger.log('hello', 'BootstrapService');
    logger.warn('careful', 'BootstrapService');
    logger.error('boom', 'BootstrapService');
    logger.debug?.('detail', 'BootstrapService');
    logger.verbose?.('noise', 'BootstrapService');

    expect(pino.calls.map((call) => [call.level, call.obj, call.msg])).toEqual([
      ['info', { context: 'BootstrapService' }, 'hello'],
      ['warn', { context: 'BootstrapService' }, 'careful'],
      ['error', { context: 'BootstrapService' }, 'boom'],
      ['debug', { context: 'BootstrapService' }, 'detail'],
      ['trace', { context: 'BootstrapService' }, 'noise'],
    ]);
  });

  it('spreads a structured message so the summary lands as fields, with its msg as the line', () => {
    const pino = recorder();

    nestLoggerFromPino(pino).log({ msg: 'Bootstrap complete', state: 'in-sync', seedsRun: true }, 'BootstrapService');

    expect(pino.calls).toEqual([
      {
        level: 'info',
        obj: { context: 'BootstrapService', state: 'in-sync', seedsRun: true },
        msg: 'Bootstrap complete',
      },
    ]);
  });

  it('keeps the stack Nest passes after an error message as `err`, with the context that follows it', () => {
    const pino = recorder();
    const stack =
      "Error: Nest can't resolve dependencies\n    at Injector.lookupComponentInParentModules (/app/main.js:10:5)";

    nestLoggerFromPino(pino).error("Nest can't resolve dependencies", stack, 'ExceptionHandler');

    expect(pino.calls[0]).toEqual({
      level: 'error',
      obj: { context: 'ExceptionHandler', err: { message: "Nest can't resolve dependencies", stack } },
      msg: "Nest can't resolve dependencies",
    });
  });

  it('does not take a stack for the context when it is the only extra argument', () => {
    const pino = recorder();
    const stack = 'Error: boom\n    at main (/app/main.js:1:1)';

    nestLoggerFromPino(pino).error('boom', stack);

    expect(pino.calls[0]).toEqual({ level: 'error', obj: { err: { message: 'boom', stack } }, msg: 'boom' });
  });

  it('keeps an Error as pino `err` so the stack is serialised, not stringified', () => {
    const pino = recorder();
    const error = new Error('bad');

    nestLoggerFromPino(pino).error(error, 'BootstrapService');

    expect(pino.calls[0]).toEqual({ level: 'error', obj: { context: 'BootstrapService', err: error }, msg: 'bad' });
  });
});
