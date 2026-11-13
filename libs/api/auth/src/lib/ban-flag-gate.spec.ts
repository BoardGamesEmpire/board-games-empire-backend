import { isAPIError } from 'better-auth/api';
import { BAN_FLAG_INVALID, createBanFlagGate } from './ban-flag-gate';

/** What a refusal carries on the wire, read off the thrown `APIError`. */
function refusalOf(attempt: () => void): { status: number; code?: string; message?: string } | undefined {
  try {
    attempt();
  } catch (error) {
    if (!isAPIError(error)) {
      throw error;
    }

    const body = error.body as { code?: string; message?: string } | undefined;
    return { status: error.statusCode, code: body?.code, message: body?.message };
  }

  return undefined;
}

describe('createBanFlagGate', () => {
  const gate = createBanFlagGate((key) => `rendered:${key}`);

  // The column refuses NULL, and anything else that isn't a boolean would
  // reach Prisma as a value it can't store. Either is the actor's mistake,
  // so it is refused before the write, never turned into `false` (#893).
  it.each([[null], ['true'], [0], [{}]])('refuses banned: %p with 400 BAN_FLAG_INVALID (#893)', (banned) => {
    expect(refusalOf(() => gate.check({ banned }))).toEqual({
      status: 400,
      code: BAN_FLAG_INVALID,
      message: 'rendered:errors.auth.ban_flag_invalid',
    });
  });

  it.each([[true], [false]])('lets banned: %p through (#893)', (banned) => {
    expect(refusalOf(() => gate.check({ banned }))).toBeUndefined();
  });

  it('lets a write without banned through, so a rename is untouched (#893)', () => {
    expect(refusalOf(() => gate.check({ name: 'x' }))).toBeUndefined();
  });

  // Prisma writes nothing for `undefined`, and a JSON body can't carry it, so
  // it is a flag left out, not a value to store.
  it('lets banned: undefined through, as a flag left out (#893)', () => {
    expect(refusalOf(() => gate.check({ name: 'x', banned: undefined }))).toBeUndefined();
  });
});
