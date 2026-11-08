import { MAIL_QUEUE_NAME } from '@bge/queue-mail';
import { createActors, type Actors } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { apiCacheTtlMs } from '../support/api-cache';
import { postToAuth } from '../support/auth-routes';
import { requireBaseUrl, requireMailpit } from '../support/e2e-env';
import { MAILPIT_FROM_ADDRESS, useMailSettings } from '../support/mail-settings';
import { mailpit, type MailpitMessage } from '../support/mailpit';
import { drainQueue, markQueueEvents } from '../support/queues';
import { useSettingSwitch } from '../support/setting-switch';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { useWorker } from '../support/worker';

const REQUEST_RESET_PATH = '/api/auth/request-password-reset';
const RESET_PATH = '/api/auth/reset-password';
const SIGN_IN_PATH = '/api/auth/sign-in/email';
const GET_SESSION_PATH = '/api/auth/get-session';
const SETTINGS_PATH = '/api/system-settings';

/** better-auth's answer to every reset request it accepts, for a registered address or not. */
const ACCEPTED = {
  status: true,
  message: 'If this email exists in our system, check your email for the reset link',
};

const NEW_PASSWORD = 'E2e!Reset12345';

/** How long a reset mail may take to reach Mailpit, from the request's answer. */
const MAIL_WAIT_MS = 10_000;

/** How long a request that mails nothing is watched for a mail job. */
const NO_MAIL_HOLD_MS = 3_000;

/**
 * Password resets through outgoing mail, end to end (#654): the api queues the
 * reset mail, the worker sends it to Mailpit, and the link in it finishes the
 * reset. The api, the worker and Mailpit are all real.
 *
 * Every request is followed by a drain of the mail queue: the jobs it queued
 * must finish, or none may appear across a hold. So a mail the worker failed
 * to send fails the test with its reason, instead of a wait for a mail that
 * never comes, and a request that should mail nothing is shown to queue
 * nothing, which an empty mailbox alone can't show.
 */
describe('password resets through outgoing mail', () => {
  const baseUrl = requireBaseUrl(process.env);
  const resetPage = `${baseUrl}/reset-password`;
  const mailbox = () => mailpit(process.env);

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const workerQueue = useWorker();
  useSettingSwitch(() => db, 'allowPasswordResets');
  const mail = useMailSettings(() => db);

  beforeEach(async () => {
    await mailbox().clear();
    await mail.pointAtMailpit();
  });

  /**
   * Asks for a reset, then waits until the worker has finished `mailJobs` mail
   * jobs the request queued. With 0, the queue must stay empty for the hold.
   */
  async function askForReset(body: { email: string; redirectTo?: string }, mailJobs: number) {
    const queue = workerQueue(MAIL_QUEUE_NAME);
    const mark = await markQueueEvents(queue);

    const response = await postToAuth(baseUrl, REQUEST_RESET_PATH).send(body);

    await drainQueue(
      queue,
      mark,
      mailJobs,
      mailJobs === 0 ? { settleMs: NO_MAIL_HOLD_MS } : { timeoutMs: MAIL_WAIT_MS },
    );

    return response;
  }

  /** The one reset mail to `address`, the link in it, and the token in the link. */
  async function resetMailTo(address: string): Promise<{ message: MailpitMessage; link: string; token: string }> {
    const messages = await mailbox().waitForMessagesTo(address, MAIL_WAIT_MS);
    expect(messages).toHaveLength(1);

    const [message] = messages as [MailpitMessage];
    const link = message.text.split(/\r?\n/).find((line) => line.startsWith(resetPage));
    if (link === undefined) {
      throw new Error(`The reset mail to ${address} holds no line starting ${resetPage}:\n${message.text}`);
    }

    const fragment = new URL(link).hash;
    return { message, link, token: decodeURIComponent(fragment.replace(/^#token=/, '')) };
  }

  const finishReset = (token: string, newPassword = NEW_PASSWORD) =>
    postToAuth(baseUrl, RESET_PATH).send({ newPassword, token });

  it('mails a link that resets the password, signs out every session, and lets the new password sign in (#654)', async () => {
    const user = await actors.user();
    const { name: serverName } = await db.client.systemSetting.findUniqueOrThrow({
      where: { singleton: true },
      select: { name: true },
    });

    const response = await askForReset({ email: user.user.email, redirectTo: resetPage }, 1);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(ACCEPTED);

    const { message, link, token } = await resetMailTo(user.user.email);
    expect(message.subject).toBe(`Reset your password on ${serverName}`);
    expect(message.text).toContain(user.user.username);
    expect(message.text).toContain(serverName);
    // The seeded lifetime, 1440 minutes, written for a person.
    expect(message.text).toContain('24 hours');
    // The token rides in the fragment, which no browser sends to the client's host.
    expect(link.startsWith(`${resetPage}#token=`)).toBe(true);

    await finishReset(token).expect(200);

    await postToAuth(baseUrl, SIGN_IN_PATH).send({ email: user.user.email, password: NEW_PASSWORD }).expect(200);
    await postToAuth(baseUrl, SIGN_IN_PATH).send({ email: user.user.email, password: user.password }).expect(401);

    // `revokeSessionsOnPasswordReset`: whoever held the old password is signed out.
    const session = await request(baseUrl).get(GET_SESSION_PATH).set(user.headers);
    expect(session.status).toBe(200);
    expect(session.body).toBeNull();

    await expect(mailbox().messagesTo(user.user.email)).resolves.toHaveLength(1);
  });

  it('refuses the same link a second time, since a reset link works once (#654)', async () => {
    const user = await actors.user();
    await askForReset({ email: user.user.email, redirectTo: resetPage }, 1);
    const { token } = await resetMailTo(user.user.email);
    await finishReset(token).expect(200);

    const again = await finishReset(token, 'E2e!Again12345');

    expect(again.status).toBe(400);
    expect(again.body).toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('gives an unknown address the answer a registered one gets, and mails it nothing (#654)', async () => {
    // The same answer for both, or the endpoint would say which addresses hold accounts.
    const user = await actors.user();
    const unknown = `e2e-nobody-${randomUUID()}@e2e.invalid`;

    const unknownResponse = await askForReset({ email: unknown, redirectTo: resetPage }, 0);
    const knownResponse = await askForReset({ email: user.user.email, redirectTo: resetPage }, 1);

    expect(unknownResponse.status).toBe(200);
    expect(unknownResponse.body).toEqual(ACCEPTED);
    expect(knownResponse.body).toEqual(unknownResponse.body);
    await expect(mailbox().messagesTo(unknown)).resolves.toEqual([]);
  });

  it('refuses a request without redirectTo with 400, and mails nothing (#654)', async () => {
    const user = await actors.user();

    const response = await askForReset({ email: user.user.email }, 0);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'PASSWORD_RESET_REDIRECT_REQUIRED' });
    await expect(mailbox().messagesTo(user.user.email)).resolves.toEqual([]);
  });

  // The link carries the token to redirectTo, so a link to another origin
  // would hand that site the account. With the origin check on, as here,
  // better-auth refuses first (INVALID_REDIRECT_URL); the reset's own check,
  // PASSWORD_RESET_REDIRECT_UNTRUSTED, holds when DISABLE_ORIGIN_CHECK turns
  // that off, and its unit spec covers it.
  it('refuses a redirectTo outside the trusted origins with 403, and mails nothing (#654)', async () => {
    const user = await actors.user();

    const response = await askForReset({ email: user.user.email, redirectTo: 'https://evil.example/reset' }, 0);

    expect(response.status).toBe(403);
    await expect(mailbox().messagesTo(user.user.email)).resolves.toEqual([]);
  });

  it('refuses with 403 once the mail settings are cleared, since no reset could be mailed (#654)', async () => {
    const user = await actors.user();
    await mail.set({ smtpHost: null, mailFromAddress: null });

    const response = await askForReset({ email: user.user.email, redirectTo: resetPage }, 0);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      code: 'MAIL_NOT_CONFIGURED',
      message:
        "This server can't send email yet, so it can't send a reset link. Ask the server's admin to set up email",
    });
  });

  it('keeps the token in Redis for the lifetime the settings give a reset link (#654)', async () => {
    const user = await actors.user();
    await mail.set({ passwordResetLinkLifetimeMinutes: 15 });

    await askForReset({ email: user.user.email, redirectTo: resetPage }, 1);
    const { message, token } = await resetMailTo(user.user.email);

    // better-auth keeps the token as the verification value `reset-password:<token>`,
    // under the auth storage's `auth_` prefix in the api's cache namespace.
    const ttlSeconds = (await apiCacheTtlMs(`auth_verification:reset-password:${token}`)) / 1000;
    expect(ttlSeconds).toBeGreaterThanOrEqual(840);
    expect(ttlSeconds).toBeLessThanOrEqual(900);
    expect(message.text).toContain('15 minutes');
  });

  it('sends with the user and password an admin set through the settings PATCH (#654)', async () => {
    // The api encrypts the password and the worker decrypts it: a mail that
    // arrives, signed in as the user, shows the two agree on the key.
    const [admin, user] = await Promise.all([actors.admin(), actors.user()]);
    const { id } = await db.client.systemSetting.findUniqueOrThrow({
      where: { singleton: true },
      select: { id: true },
    });
    const { smtpHost, smtpPort } = requireMailpit(process.env);

    const patched = await request(baseUrl).patch(`${SETTINGS_PATH}/${id}`).set(admin.headers).send({
      smtpHost,
      smtpPort,
      smtpSecurity: 'None',
      smtpUser: 'bge',
      smtpPassword: 'pw',
      mailFromAddress: MAILPIT_FROM_ADDRESS,
    });

    expect(patched.status).toBe(200);
    expect(patched.body.settings).toMatchObject({ smtpUser: 'bge', smtpPasswordSet: true });
    expect(patched.body.settings).not.toHaveProperty('smtpPassword');

    const stored = await db.client.systemSetting.findUniqueOrThrow({
      where: { id },
      select: { smtpPassword: true },
    });
    expect(stored.smtpPassword).toEqual(expect.any(String));
    expect(stored.smtpPassword).not.toBe('pw');

    await askForReset({ email: user.user.email, redirectTo: resetPage }, 1);
    const { message } = await resetMailTo(user.user.email);

    expect(message.username).toBe('bge');

    // The stored password goes only to the server it was saved for: a new
    // host that keeps it would send it wherever the editor points.
    const moved = await request(baseUrl)
      .patch(`${SETTINGS_PATH}/${id}`)
      .set(admin.headers)
      .send({ smtpHost: 'smtp.elsewhere.example' });

    expect(moved.status).toBe(400);
    expect(moved.body).toMatchObject({ code: 'SMTP_PASSWORD_REQUIRED' });
  });
});
