// The subpath, for the reason given in global-setup, which imports this file.
import { pollUntil } from '@bge/testing-e2e/poll';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { MAILPIT_IMAGE, requireMailpit, type MailpitEndpoint } from './e2e-env';

/** Mailpit's SMTP port inside its container. */
const MAILPIT_SMTP_PORT = 1025;

/** Mailpit's HTTP API (and web UI) port inside its container. */
const MAILPIT_API_PORT = 8025;

/** A Mailpit container `global-setup` started, and the way to stop it. */
export interface StartedMailpit extends MailpitEndpoint {
  stop(): Promise<void>;
}

/**
 * Starts the SMTP server the suite's outgoing mail reaches (#654).
 *
 * It accepts any SMTP user and password, or none, and over a plain connection,
 * so a spec can point the mail settings at it with `None` security and still
 * send a user and password: the password the worker decrypted reaches it, and
 * nothing checks it. The wait is on `/livez`, which answers once the HTTP API
 * is up; the SMTP server starts before it.
 */
export async function startMailpit(): Promise<StartedMailpit> {
  const container: StartedTestContainer = await new GenericContainer(MAILPIT_IMAGE)
    .withEnvironment({ MP_SMTP_AUTH_ACCEPT_ANY: 'true', MP_SMTP_AUTH_ALLOW_INSECURE: 'true' })
    .withExposedPorts(MAILPIT_SMTP_PORT, MAILPIT_API_PORT)
    .withWaitStrategy(Wait.forHttp('/livez', MAILPIT_API_PORT))
    .start();

  const host = container.getHost();

  return {
    smtpHost: host,
    smtpPort: container.getMappedPort(MAILPIT_SMTP_PORT),
    apiUrl: `http://${host}:${container.getMappedPort(MAILPIT_API_PORT)}`,
    stop: async () => {
      await container.stop();
    },
  };
}

/** One message Mailpit holds, as a spec reads it. */
export interface MailpitMessage {
  readonly id: string;
  readonly subject: string;
  /** The plain-text body. */
  readonly text: string;
  /** The SMTP user the sender signed in as, or `''` when it sent none. */
  readonly username: string;
}

export interface MailpitClient {
  /** Every message Mailpit holds addressed to `address`, newest first. */
  messagesTo(address: string): Promise<MailpitMessage[]>;

  /**
   * Polls until a message to `address` arrives and answers every one then held.
   * On timeout it throws, naming the address.
   */
  waitForMessagesTo(address: string, timeoutMs: number): Promise<MailpitMessage[]>;

  /** Deletes every message Mailpit holds. */
  clear(): Promise<void>;
}

async function requireOk(response: Response, what: string): Promise<Response> {
  if (!response.ok) {
    throw new Error(`Mailpit answered ${response.status} to ${what}: ${await response.text()}`);
  }

  return response;
}

async function readJson(response: Response, what: string): Promise<unknown> {
  return (await requireOk(response, what)).json();
}

/**
 * A client for the Mailpit API `global-setup` published in `BGE_E2E_MAILPIT`.
 * It reads the mail the worker sent; it is the suite's only view of a message,
 * since no HTTP response from the API carries one.
 */
export function mailpit(env: NodeJS.ProcessEnv = process.env): MailpitClient {
  const { apiUrl } = requireMailpit(env);

  const messagesTo = async (address: string): Promise<MailpitMessage[]> => {
    const query = new URLSearchParams({ query: `to:"${address}"` });
    const search = (await readJson(
      await fetch(`${apiUrl}/api/v1/search?${query.toString()}`),
      `a search for mail to ${address}`,
    )) as { messages?: Array<{ ID: string }> };

    return Promise.all(
      (search.messages ?? []).map(async ({ ID }) => {
        const message = (await readJson(await fetch(`${apiUrl}/api/v1/message/${ID}`), `a read of message ${ID}`)) as {
          ID: string;
          Subject: string;
          Text: string;
          Username?: string;
        };

        return { id: message.ID, subject: message.Subject, text: message.Text, username: message.Username ?? '' };
      }),
    );
  };

  return {
    messagesTo,

    waitForMessagesTo: (address, timeoutMs) =>
      pollUntil(
        async () => {
          const messages = await messagesTo(address);
          return messages.length > 0 ? messages : undefined;
        },
        { description: `a mail to ${address} to reach Mailpit`, timeoutMs, intervalMs: 200 },
      ),

    clear: async () => {
      // Answers a bare `ok`, not JSON.
      await requireOk(await fetch(`${apiUrl}/api/v1/messages`, { method: 'DELETE' }), 'a delete of every message');
    },
  };
}
