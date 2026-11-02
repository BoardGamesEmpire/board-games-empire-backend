import { createActors, SET_AUTH_TOKEN_HEADER, type Actors, type SessionActor } from '@bge/testing-e2e';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { postToAuth } from '../support/auth-routes';
import { requireBaseUrl } from '../support/e2e-env';
import { cookiePairs, sessionCookieOf } from '../support/sign-in-provider';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const ENABLE_PATH = '/api/auth/two-factor/enable';
const VERIFY_TOTP_PATH = '/api/auth/two-factor/verify-totp';
const SIGN_IN_PATH = '/api/auth/sign-in/email';
const LIST_SESSIONS_PATH = '/api/auth/list-sessions';

/**
 * better-auth's two-factor plugin gives a user ten consecutive wrong codes,
 * across sign-ins, before it locks the user out, and each sign-in's challenge
 * takes five of them before it is spent (`verify-two-factor.mjs`: the
 * `maxFailedAttempts` default, and `beginAttempt(5)`). So ten wrong codes
 * take two challenges. The api sets neither option, so these are the
 * plugin's defaults, and they are what a change of either would move.
 */
const WRONG_CODES_PER_CHALLENGE = 5;
const CHALLENGES_TO_LOCK = 2;
const WRONG_CODES_TO_LOCK = WRONG_CODES_PER_CHALLENGE * CHALLENGES_TO_LOCK;

/** The plugin's stable codes, which the api passes through as they are. */
const INVALID_CODE = 'INVALID_CODE';
const ACCOUNT_TEMPORARILY_LOCKED = 'ACCOUNT_TEMPORARILY_LOCKED';

const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
/** The plugin accepts the code for the current 30-second step and for the step on either side. */
const ACCEPTED_STEPS_EACH_SIDE = 1;
/**
 * A wrong code stays wrong for this many steps on either side, two more than
 * the plugin accepts: a request can reach the server in the next step from
 * the one the code was computed in, and a step boundary must not turn a
 * wrong code into a right one.
 */
const WRONG_CODE_MARGIN_STEPS = ACCEPTED_STEPS_EACH_SIDE + 2;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, the encoding of the secret in a TOTP provisioning URI. */
function base32Decode(encoded: string): Buffer {
  const bytes: number[] = [];
  let buffered = 0;
  let bits = 0;

  for (const character of encoded.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) {
      throw new Error(`'${character}' is not a base32 character, in the TOTP secret '${encoded}'`);
    }

    buffered = (buffered << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffered >> bits) & 0xff);
    }
  }

  return Buffer.from(bytes);
}

/** RFC 4226's HOTP with HMAC-SHA-1, the code for one counter value. */
function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const truncated = digest.readUInt32BE(offset) & 0x7fffffff;

  return String(truncated % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

const currentStep = (): number => Math.floor(Date.now() / (TOTP_PERIOD_SECONDS * 1000));

/** RFC 6238's code for now. Compute it as late as possible: it is good for about a minute. */
const rightCode = (secret: Buffer): string => hotp(secret, currentStep());

/** A code that is none of those within {@link WRONG_CODE_MARGIN_STEPS} steps of now. */
function wrongCode(secret: Buffer): string {
  const step = currentStep();
  const nearby = new Set<string>();

  for (let offset = -WRONG_CODE_MARGIN_STEPS; offset <= WRONG_CODE_MARGIN_STEPS; offset++) {
    nearby.add(hotp(secret, step + offset));
  }

  // One more candidate than there are codes to avoid, so one is free.
  for (let candidate = 0; candidate <= nearby.size; candidate++) {
    const code = String(candidate).padStart(TOTP_DIGITS, '0');
    if (!nearby.has(code)) {
      return code;
    }
  }

  throw new Error('no six-digit code is outside the codes to avoid');
}

/** The `name=value` of the cookie the two-factor step is carried in, from a sign-in's `Set-Cookie` headers. */
function twoFactorCookie(setCookie: readonly string[] | string | undefined): string {
  const pair = cookiePairs(setCookie).find((candidate) => /two_factor=.+/.test(candidate));

  if (pair === undefined) {
    throw new Error(`the sign-in set no two-factor cookie: ${JSON.stringify(setCookie)}`);
  }

  return pair;
}

/**
 * The per-user lockout of two-factor sign-in (#1016). better-auth 1.7
 * counts wrong codes per user, in `failed_verification_count`, and writes
 * `locked_until` when the count reaches its limit. The columns are what make
 * the lock hold across sign-ins, so this reads them from the database, and
 * the 429 it expects is the plugin's lock refusing a right code, not
 * better-auth's rate limiter, which is off under `NODE_ENV=test`.
 */
describe('the two-factor lockout', () => {
  const baseUrl = requireBaseUrl(process.env);

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const twoFactorOf = (userId: string) =>
    db.client.twoFactor.findFirstOrThrow({
      where: { userId },
      select: { verified: true, failedVerificationCount: true, lockedUntil: true },
    });

  /**
   * The ids of the sessions better-auth lists for the user the token belongs
   * to. They are read from the route because that is where they live: the api
   * keeps sessions in its secondary storage and, with `storeSessionInDatabase`
   * unset, writes no `session` row, so a count of rows is 0 whatever happens
   * (#1016).
   */
  const sessionIdsOf = async (token: string): Promise<string[]> => {
    const listed = await request(baseUrl).get(LIST_SESSIONS_PATH).set('Authorization', `Bearer ${token}`).expect(200);

    return listed.body.map((session: { id: string }) => session.id).sort();
  };

  /**
   * Signs in with the password and returns the cookie of the two-factor step it ends at.
   *
   * The response still carries `set-auth-token`, for the session the plugin
   * deletes before it answers: bearer() reads the token from the credential
   * sign-in's cookie, ahead of the two-factor hook. So the header says nothing
   * about whether a session exists, and neither does the session table, which
   * the api never writes. The test lists sessions and looks for a session cookie.
   */
  const signInToTwoFactorStep = async (actor: SessionActor): Promise<string> => {
    const response = await postToAuth(baseUrl, SIGN_IN_PATH)
      .send({ email: actor.user.email, password: actor.password })
      .expect(200);

    expect(response.body).toMatchObject({ twoFactorRedirect: true });

    return twoFactorCookie(response.headers['set-cookie']);
  };

  /** A code sent to the two-factor step. Only that cookie goes with it: a session would make it a confirmation instead. */
  const verifyAtTwoFactorStep = (cookie: string, code: string) =>
    postToAuth(baseUrl, VERIFY_TOTP_PATH).set('Cookie', cookie).send({ code });

  it('locks a user out after ten wrong two-factor codes, and writes the columns (#1016)', async () => {
    const actor = await actors.user();

    const enabled = await postToAuth(baseUrl, ENABLE_PATH)
      .set(actor.headers)
      .send({ password: actor.password })
      .expect(200);
    const totpSecret = new URL(enabled.body.totpURI).searchParams.get('secret');
    if (!totpSecret) {
      throw new Error(`the TOTP URI carries no secret: ${enabled.body.totpURI}`);
    }
    const secret = base32Decode(totpSecret);

    // Confirming the code is what turns two-factor on, and replaces the signup
    // session with one that passed it. The new session's token is in the
    // header; the body's `token` is the replaced session's.
    const confirmation = await postToAuth(baseUrl, VERIFY_TOTP_PATH)
      .set(actor.headers)
      .send({ code: rightCode(secret) })
      .expect(200);
    const token = confirmation.headers[SET_AUTH_TOKEN_HEADER];
    if (typeof token !== 'string') {
      throw new Error(`the confirmation set no session token: ${JSON.stringify(confirmation.headers)}`);
    }

    // Nothing has failed yet, so the columns start clean. The sessions list
    // is not empty, or every comparison against it below would hold for nothing.
    expect(await twoFactorOf(actor.user.id)).toEqual({ verified: true, failedVerificationCount: 0, lockedUntil: null });
    const sessionsBeforeLockout = await sessionIdsOf(token);
    expect(sessionsBeforeLockout.length).toBeGreaterThan(0);

    for (let challenge = 0; challenge < CHALLENGES_TO_LOCK; challenge++) {
      const cookie = await signInToTwoFactorStep(actor);

      for (let attempt = 0; attempt < WRONG_CODES_PER_CHALLENGE; attempt++) {
        const refused = await verifyAtTwoFactorStep(cookie, wrongCode(secret));

        expect(refused.status).toBe(401);
        expect(refused.body.code).toBe(INVALID_CODE);
        expect(sessionCookieOf(refused.headers['set-cookie'])).toBe('');
      }
    }

    // No wrong code opened a session, and the last of them wrote the lock.
    await expect(sessionIdsOf(token)).resolves.toEqual(sessionsBeforeLockout);
    const afterWrongCodes = await twoFactorOf(actor.user.id);
    expect(afterWrongCodes.failedVerificationCount).toBe(WRONG_CODES_TO_LOCK);
    expect(afterWrongCodes.lockedUntil).toBeInstanceOf(Date);

    // The right code, from a fresh sign-in, as the user would try it. The lock, not the code, decides.
    const cookie = await signInToTwoFactorStep(actor);
    const refusal = await verifyAtTwoFactorStep(cookie, rightCode(secret));

    expect(refusal.status).toBe(429);
    expect(refusal.body.code).toBe(ACCOUNT_TEMPORARILY_LOCKED);
    expect(sessionCookieOf(refusal.headers['set-cookie'])).toBe('');
    await expect(sessionIdsOf(token)).resolves.toEqual(sessionsBeforeLockout);

    // A refused right code is not a failure: the count stays where the wrong codes left it, and the lock stays.
    const locked = await twoFactorOf(actor.user.id);
    const now = Date.now();
    expect(locked.failedVerificationCount).toBe(WRONG_CODES_TO_LOCK);
    expect(locked.lockedUntil?.getTime()).toBeGreaterThan(now);
    // The default lock is 15 minutes. An hour only catches a unit mixup, seconds read as milliseconds or the reverse.
    expect(locked.lockedUntil?.getTime()).toBeLessThan(now + 60 * 60 * 1000);
    expect(locked.lockedUntil).toEqual(afterWrongCodes.lockedUntil);
  });
});
