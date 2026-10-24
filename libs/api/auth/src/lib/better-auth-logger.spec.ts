import { betterAuthLogger } from './better-auth-logger';

function fakeNest() {
  return { debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

describe('betterAuthLogger (betterAuth logger option, #627)', () => {
  it.each([
    ['debug', 'debug'],
    ['info', 'log'],
    ['warn', 'warn'],
    ['error', 'error'],
  ] as const)('hands each better-auth level to the matching Nest level (%s to %s)', (level, method) => {
    const nest = fakeNest();

    betterAuthLogger(nest).log?.(level, 'm');

    expect(nest[method]).toHaveBeenCalledWith(expect.objectContaining({ msg: 'm' }));
  });

  // An Error in the arguments has to reach pino as `err`, whose serializer
  // writes the stack into the same record instead of a second console line.
  it('passes an error argument as err, so its stack stays one record', () => {
    const nest = fakeNest();

    betterAuthLogger(nest).log?.('error', 'failed', new Error('boom'));

    expect(nest.error).toHaveBeenCalledWith({
      msg: 'failed',
      err: expect.objectContaining({ message: 'boom' }),
    });
  });

  it('keeps other arguments as fields', () => {
    const nest = fakeNest();

    betterAuthLogger(nest).log?.('warn', 'w', { userId: 'u1' });

    expect(nest.warn).toHaveBeenCalledWith({ msg: 'w', args: [{ userId: 'u1' }] });
  });

  it('keeps arguments other than the first error as fields', () => {
    const nest = fakeNest();
    const first = new Error('first');

    betterAuthLogger(nest).log?.('error', 'e', 'detail', first, 3);

    expect(nest.error).toHaveBeenCalledWith({ msg: 'e', err: first, args: ['detail', 3] });
  });

  // better-auth drops lines below its own `level` before calling `log`. Its
  // info lines include personal data (the email on a repeated sign-up), so a
  // lower threshold would make production print what it never printed before.
  it("keeps better-auth's own warn threshold, so lines it never printed stay out (#627)", () => {
    expect(betterAuthLogger(fakeNest()).level).toBe('warn');
  });
});
