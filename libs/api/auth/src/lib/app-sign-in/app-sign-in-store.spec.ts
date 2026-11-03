import { createHash } from 'node:crypto';
import { APP_SIGN_IN_LIFETIME_MS, type AppSignInFlow, createAppSignInStore } from './app-sign-in-store';
import { parseAppReturnAddress } from './return-address';
import { memoryVerificationStore } from './verification-store.fixture';

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

const returnAddress = (value: string): URL => {
  const address = parseAppReturnAddress(value);
  if (address === null) {
    throw new Error(`${value} is not a return address the server accepts`);
  }

  return address;
};

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const FLOW: AppSignInFlow = {
  returnAddress: returnAddress('bge://oauth/server-7'),
  codeChallenge: CHALLENGE,
  state: 'a&b',
};
const CODE_RECORD = { userId: 'user-1', codeChallenge: CHALLENGE };

/** A flow as plain values, its address by `href`, for comparing. */
const plain = (flow: AppSignInFlow | null) => flow && { ...flow, returnAddress: flow.returnAddress.href };

describe('createAppSignInStore', () => {
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    clock = Date.parse('2026-11-03T12:00:00Z');
  });

  // The flow carries the app's request across the provider's sign-in, and the
  // callback takes it exactly once (#1019).
  it('gives back an open flow once, then nothing (#1019)', async () => {
    const { store } = memoryVerificationStore(now);
    const appSignIn = createAppSignInStore(store, now);

    const flowId = await appSignIn.openFlow(FLOW);

    expect(plain(await appSignIn.takeFlow(flowId))).toEqual({
      returnAddress: 'bge://oauth/server-7',
      codeChallenge: CHALLENGE,
      state: 'a&b',
    });
    await expect(appSignIn.takeFlow(flowId)).resolves.toBeNull();
  });

  it('keeps a flow without a state as one without a state (#1019)', async () => {
    const { store } = memoryVerificationStore(now);
    const appSignIn = createAppSignInStore(store, now);

    const flowId = await appSignIn.openFlow({ returnAddress: returnAddress('bge://oauth'), codeChallenge: CHALLENGE });

    expect(plain(await appSignIn.takeFlow(flowId))).toEqual({ returnAddress: 'bge://oauth', codeChallenge: CHALLENGE });
  });

  // Only the code's hash is stored, so a copy of the store can't redeem one
  // (#1019).
  it('issues a 32-character code, stores only its hash, and redeems it once (#1019)', async () => {
    const { store, records } = memoryVerificationStore(now);
    const appSignIn = createAppSignInStore(store, now);

    const code = await appSignIn.issueCode(CODE_RECORD);

    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect([...records.keys()]).toEqual([`app-sign-in-code:${sha256Hex(code)}`]);
    for (const [identifier, record] of records) {
      expect(identifier).not.toContain(code);
      expect(record.value).not.toContain(code);
    }
    await expect(appSignIn.redeemCode(code)).resolves.toEqual(CODE_RECORD);
    await expect(appSignIn.redeemCode(code)).resolves.toBeNull();
  });

  it('issues a different code each time (#1019)', async () => {
    const { store } = memoryVerificationStore(now);
    const appSignIn = createAppSignInStore(store, now);

    const codes = await Promise.all([appSignIn.issueCode(CODE_RECORD), appSignIn.issueCode(CODE_RECORD)]);

    expect(new Set(codes).size).toBe(2);
  });

  it('redeems nothing for a code it never issued (#1019)', async () => {
    const { store } = memoryVerificationStore(now);
    const appSignIn = createAppSignInStore(store, now);
    await appSignIn.issueCode(CODE_RECORD);

    await expect(appSignIn.redeemCode('a-code-this-store-never-issued--')).resolves.toBeNull();
  });

  // Each record lives ten minutes; an end-to-end test can't wait that long.
  it('stores every record to expire ten minutes from now (#1019)', async () => {
    const { store, records } = memoryVerificationStore(now);
    const appSignIn = createAppSignInStore(store, now);

    await appSignIn.openFlow(FLOW);
    await appSignIn.issueCode(CODE_RECORD);

    expect(records.size).toBe(2);
    for (const record of records.values()) {
      expect(record.expiresAt.getTime()).toBe(clock + 600_000);
    }
    expect(APP_SIGN_IN_LIFETIME_MS).toBe(600_000);
  });

  it('gives back neither a flow nor a code once ten minutes have passed (#1019)', async () => {
    const { store } = memoryVerificationStore(now);
    const appSignIn = createAppSignInStore(store, now);
    const flowId = await appSignIn.openFlow(FLOW);
    const code = await appSignIn.issueCode(CODE_RECORD);

    clock += APP_SIGN_IN_LIFETIME_MS + 1;

    await expect(appSignIn.takeFlow(flowId)).resolves.toBeNull();
    await expect(appSignIn.redeemCode(code)).resolves.toBeNull();
  });

  // A record that doesn't read as one of ours is no flow and no code, rather
  // than an error a request would answer 500 to.
  it.each([
    ['not JSON', 'not json'],
    ['JSON of the wrong shape', JSON.stringify({ returnAddress: 7 })],
    ['JSON null', 'null'],
  ])('reads a record that is %s as nothing (#1019)', async (_case, value) => {
    const { store, records } = memoryVerificationStore(now);
    const appSignIn = createAppSignInStore(store, now);
    const flowId = await appSignIn.openFlow(FLOW);
    const code = await appSignIn.issueCode(CODE_RECORD);
    for (const [identifier, record] of records) {
      records.set(identifier, { ...record, value });
    }

    await expect(appSignIn.takeFlow(flowId)).resolves.toBeNull();
    await expect(appSignIn.redeemCode(code)).resolves.toBeNull();
  });

  // The address is checked again on the way out, so a flow never sends a code
  // anywhere the server wouldn't accept as a return address (#1019).
  it('reads a flow whose address is no longer a return address as nothing (#1019)', async () => {
    const { store, records } = memoryVerificationStore(now);
    const appSignIn = createAppSignInStore(store, now);
    const flowId = await appSignIn.openFlow(FLOW);
    for (const [identifier, record] of records) {
      records.set(identifier, {
        ...record,
        value: JSON.stringify({ returnAddress: 'https://attacker.example/cb', codeChallenge: CHALLENGE }),
      });
    }

    await expect(appSignIn.takeFlow(flowId)).resolves.toBeNull();
  });
});
