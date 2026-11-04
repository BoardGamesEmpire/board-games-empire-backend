import { generateRandomString } from 'better-auth/crypto';
import { createHash } from 'node:crypto';
import { type JsonObject, parseJsonObject } from './json-object';
import { parseAppReturnAddress } from './return-address';

/** How long an app sign-in's flow, and the code issued for it, last: ten minutes (#1019). */
export const APP_SIGN_IN_LIFETIME_MS = 10 * 60 * 1000;

/** Random characters in a flow id and in a code: 192 bits from better-auth's 64-character alphabet. */
const RANDOM_LENGTH = 32;

const FLOW_PREFIX = 'app-sign-in-flow:';
const CODE_PREFIX = 'app-sign-in-code:';

/** A native app's sign-in request, kept while the person signs in at the provider (#1019). */
export interface AppSignInFlow {
  /** The return address the app asked for, parsed: one the server sends sign-ins to. */
  readonly returnAddress: URL;
  /** The app's PKCE challenge, which the code is bound to. */
  readonly codeChallenge: string;
  /** The app's `state`, sent back to it unchanged. Absent when the app sent none. */
  readonly state?: string;
}

/** The record a code stands for: the user who signed in, and the challenge the app's verifier must match. */
export interface AppSignInCodeRecord {
  readonly userId: string;
  readonly codeChallenge: string;
}

/**
 * The slice of better-auth's internal adapter the records go through: its
 * verification store, which is Redis here. A record is taken out with
 * `consumeVerificationValue`, once, and one past its expiry reads as gone.
 */
export interface VerificationStore {
  createVerificationValue(data: { identifier: string; value: string; expiresAt: Date }): Promise<unknown>;
  consumeVerificationValue(identifier: string): Promise<{ readonly value: string } | null>;
}

export interface AppSignInStore {
  /** Records the app's request, and returns the flow's id. */
  openFlow(flow: AppSignInFlow): Promise<string>;
  /**
   * The flow, once: a second take, or one after it expired, finds nothing.
   * So does a flow whose address is no longer one the server sends sign-ins to.
   */
  takeFlow(flowId: string): Promise<AppSignInFlow | null>;
  /** Records a single-use code standing for `record`, and returns the code. Only its hash is stored. */
  issueCode(record: AppSignInCodeRecord): Promise<string>;
  /** The record a code stands for, once: a second redeem, an unknown code or one that expired finds nothing. */
  redeemCode(code: string): Promise<AppSignInCodeRecord | null>;
}

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

function toFlow(record: JsonObject | null): AppSignInFlow | null {
  const returnAddress =
    typeof record?.['returnAddress'] === 'string' ? parseAppReturnAddress(record['returnAddress']) : null;

  if (
    record === null ||
    returnAddress === null ||
    typeof record['codeChallenge'] !== 'string' ||
    (record['state'] !== undefined && typeof record['state'] !== 'string')
  ) {
    return null;
  }

  const flow = { returnAddress, codeChallenge: record['codeChallenge'] };
  return typeof record['state'] === 'string' ? { ...flow, state: record['state'] } : flow;
}

function toCodeRecord(record: JsonObject | null): AppSignInCodeRecord | null {
  if (record === null || typeof record['userId'] !== 'string' || typeof record['codeChallenge'] !== 'string') {
    return null;
  }

  return { userId: record['userId'], codeChallenge: record['codeChallenge'] };
}

/**
 * The records an app sign-in keeps in better-auth's verification store
 * (#1019): the flow, from the app's request until the callback, and the code,
 * from the callback until the app exchanges it. Each is single use and lives
 * {@link APP_SIGN_IN_LIFETIME_MS}. No session is kept between requests: the
 * callback hands its session over in the same request.
 */
export function createAppSignInStore(store: VerificationStore, now: () => number = Date.now): AppSignInStore {
  const save = async (identifier: string, value: object): Promise<void> => {
    const saved = await store.createVerificationValue({
      identifier,
      value: JSON.stringify(value),
      expiresAt: new Date(now() + APP_SIGN_IN_LIFETIME_MS),
    });

    if (!saved) {
      throw new Error('The app sign-in record could not be stored');
    }
  };

  const take = async (identifier: string): Promise<JsonObject | null> => {
    const record = await store.consumeVerificationValue(identifier);
    return record === null ? null : parseJsonObject(record.value);
  };

  return {
    async openFlow(flow) {
      const flowId = generateRandomString(RANDOM_LENGTH);
      await save(`${FLOW_PREFIX}${flowId}`, { ...flow, returnAddress: flow.returnAddress.href });
      return flowId;
    },

    async takeFlow(flowId) {
      return toFlow(await take(`${FLOW_PREFIX}${flowId}`));
    },

    async issueCode(record) {
      const code = generateRandomString(RANDOM_LENGTH);
      await save(`${CODE_PREFIX}${sha256Hex(code)}`, { userId: record.userId, codeChallenge: record.codeChallenge });
      return code;
    },

    async redeemCode(code) {
      return toCodeRecord(await take(`${CODE_PREFIX}${sha256Hex(code)}`));
    },
  };
}
