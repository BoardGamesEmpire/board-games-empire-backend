import { isAPIError } from 'better-auth/api';
import {
  createUserRemovalGate,
  REMOVE_USER_PATH,
  USER_REMOVAL_BLOCKED,
  type UserRemovalGateDeps,
} from './user-removal-gate';

/** What a refusal carries on the wire, read off the rejected `APIError`. */
async function refusalOf(
  attempt: () => Promise<void>,
): Promise<{ status: number; code?: string; message?: string } | undefined> {
  try {
    await attempt();
  } catch (error) {
    if (!isAPIError(error)) {
      throw error;
    }

    const body = error.body as { code?: string; message?: string } | undefined;
    return { status: error.statusCode, code: body?.code, message: body?.message };
  }

  return undefined;
}

describe('createUserRemovalGate', () => {
  const REFUSAL = {
    status: 409,
    code: USER_REMOVAL_BLOCKED,
    message: 'rendered:errors.auth.user_removal_blocked',
  };

  const removal = { path: REMOVE_USER_PATH };

  const gateWith = (shared: boolean) => {
    const hasSharedData = jest.fn<Promise<boolean>, [string]>().mockResolvedValue(shared);
    const deps: UserRemovalGateDeps = { hasSharedData, render: (key) => `rendered:${key}` };

    return { gate: createUserRemovalGate(deps), hasSharedData };
  };

  // better-auth deletes the user's sign-in methods before the user row, with no
  // transaction, so the account hook is the first point that can refuse with
  // nothing deleted (#1054).
  it('refuses removal of a user with shared data with 409 USER_REMOVAL_BLOCKED, from the account hook (#1054)', async () => {
    const { gate, hasSharedData } = gateWith(true);

    await expect(refusalOf(() => gate.beforeAccountDelete({ userId: 'u1' }, removal))).resolves.toEqual(REFUSAL);
    expect(hasSharedData).toHaveBeenCalledWith('u1');
  });

  // A user with no sign-in methods never reaches the account hook, so the user
  // hook refuses for them (#1054).
  it('refuses from the user hook too, for a user with no sign-in methods (#1054)', async () => {
    const { gate, hasSharedData } = gateWith(true);

    await expect(refusalOf(() => gate.beforeUserDelete({ id: 'u1' }, removal))).resolves.toEqual(REFUSAL);
    expect(hasSharedData).toHaveBeenCalledWith('u1');
  });

  it('lets a user with no shared data be removed (#1054)', async () => {
    const { gate } = gateWith(false);

    await expect(refusalOf(() => gate.beforeAccountDelete({ userId: 'u1' }, removal))).resolves.toBeUndefined();
    await expect(refusalOf(() => gate.beforeUserDelete({ id: 'u1' }, removal))).resolves.toBeUndefined();
  });

  // The anonymous plugin deletes through the same hooks, on request and once
  // an anonymous user signs up. Neither is refused, and neither pays for the
  // read (#1054).
  it.each([['/delete-anonymous-user'], ['/sign-up/email'], [undefined]])(
    'never refuses or reads on path %p, so anonymous cleanup is untouched (#1054)',
    async (path) => {
      const { gate, hasSharedData } = gateWith(true);

      await expect(refusalOf(() => gate.beforeAccountDelete({ userId: 'u1' }, { path }))).resolves.toBeUndefined();
      await expect(refusalOf(() => gate.beforeUserDelete({ id: 'u1' }, { path }))).resolves.toBeUndefined();
      expect(hasSharedData).not.toHaveBeenCalled();
    },
  );

  it('never refuses or reads without an endpoint context, as on a direct adapter call (#1054)', async () => {
    const { gate, hasSharedData } = gateWith(true);

    await expect(refusalOf(() => gate.beforeAccountDelete({ userId: 'u1' }, null))).resolves.toBeUndefined();
    await expect(refusalOf(() => gate.beforeUserDelete({ id: 'u1' }, null))).resolves.toBeUndefined();
    expect(hasSharedData).not.toHaveBeenCalled();
  });
});
