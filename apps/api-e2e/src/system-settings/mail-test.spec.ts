import { MAIL_QUEUE_NAME } from '@bge/queue-mail';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { createServer } from 'node:net';
import request from 'supertest';
import type { UnreadNotificationWire } from '../notification/notification-wire';
import { unreadWhen } from '../notification/unread-poll';
import { requireBaseUrl } from '../support/e2e-env';
import { useMailSettings } from '../support/mail-settings';
import { mailpit } from '../support/mailpit';
import { drainQueue, markQueueEvents } from '../support/queues';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { useWorker } from '../support/worker';

const MAIL_TEST_PATH = '/api/system-settings/mail-test';

/** How long the test email may take to reach Mailpit. */
const MAIL_WAIT_MS = 10_000;

/**
 * How long a failed test email's notification may take. The SMTP connection
 * gives up after 30 seconds, so a host that never answers is reported inside
 * this; a closed port is refused at once.
 */
const FAILURE_WAIT_MS = 40_000;

/** A port on this machine that nothing listens on: one the system just handed out and took back. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

  if (address === null || typeof address === 'string') {
    throw new Error(`Expected a TCP address from the probe server, got ${String(address)}`);
  }

  return address.port;
}

const isMailTestResult = (notification: UnreadNotificationWire) => notification.type === 'MailTestResult';

/**
 * An admin's test email (#654): the api queues it for the admin's own address,
 * the worker sends it, and the admin learns the outcome from a notification,
 * whose message is plain language with a stable code beside it.
 */
describe('the test email', () => {
  const baseUrl = requireBaseUrl(process.env);
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
  const mail = useMailSettings(() => db);

  beforeEach(async () => {
    await mailbox().clear();
  });

  /**
   * Sends the test email as `actor`, then waits until the worker has finished
   * every job the request queued: one for a 202, none otherwise.
   */
  async function sendTest(actor: SessionActor) {
    const queue = workerQueue(MAIL_QUEUE_NAME);
    const mark = await markQueueEvents(queue);

    const response = await request(baseUrl).post(MAIL_TEST_PATH).set(actor.headers);

    await drainQueue(queue, mark, response.status === 202 ? 1 : 0, { timeoutMs: FAILURE_WAIT_MS });

    return response;
  }

  it("mails the admin's own address, and tells them it was sent (#654)", async () => {
    const admin = await actors.admin();
    await mail.pointAtMailpit();
    const { name: serverName } = await db.client.systemSetting.findUniqueOrThrow({
      where: { singleton: true },
      select: { name: true },
    });

    const response = await sendTest(admin);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ queued: true });

    const messages = await mailbox().waitForMessagesTo(admin.user.email, MAIL_WAIT_MS);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.subject).toBe(`Test email from ${serverName}`);

    const unread = await unreadWhen(baseUrl, admin, (list) => list.some(isMailTestResult));
    expect(unread.filter(isMailTestResult).map((notification) => notification.payload)).toEqual([
      {
        outcome: 'sent',
        code: null,
        message: "The test email was sent to your address. If it isn't in your inbox, check your spam folder.",
      },
    ]);
  });

  it("tells the admin, with a stable code, that the SMTP host couldn't be reached (#654)", async () => {
    const admin = await actors.admin();
    await mail.pointAtMailpit();
    await mail.set({ smtpHost: '127.0.0.1', smtpPort: await closedPort() });

    const response = await sendTest(admin);

    expect(response.status).toBe(202);

    const unread = await unreadWhen(baseUrl, admin, (list) => list.some(isMailTestResult), {
      timeoutMs: FAILURE_WAIT_MS,
    });
    expect(unread.filter(isMailTestResult).map((notification) => notification.payload)).toEqual([
      {
        outcome: 'failed',
        code: 'MAIL_HOST_UNREACHABLE',
        message:
          "The test email wasn't sent, because this server couldn't connect to the SMTP host. Check the host and port in the mail settings.",
      },
    ]);
    await expect(mailbox().messagesTo(admin.user.email)).resolves.toEqual([]);
  });

  it('refuses a user who may not change the settings with 403 (#654)', async () => {
    const user = await actors.user();
    await mail.pointAtMailpit();

    const response = await sendTest(user);

    expect(response.status).toBe(403);
  });

  it('refuses with 409 while outgoing mail is not set up (#654)', async () => {
    const admin = await actors.admin();
    await mail.set({ smtpHost: null, mailFromAddress: null });

    const response = await sendTest(admin);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'MAIL_NOT_CONFIGURED',
      message:
        "Email isn't set up on this server yet. Add an SMTP host and a From address to the mail settings, then try again",
    });
  });
});
