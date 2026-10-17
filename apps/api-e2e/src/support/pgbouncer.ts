import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { E2E_DATABASE_CONTAINER_ADDRESS_VAR } from './e2e-env';

/**
 * CloudNativePG's PgBouncer image, the one the target cluster's connection
 * pooler runs (#596). From ghcr.io rather than Docker Hub (#683), and pinned by
 * the digest of its multi-platform index.
 */
export const PGBOUNCER_IMAGE =
  'ghcr.io/cloudnative-pg/pgbouncer:1.26.0@sha256:ce54f1133c509f1db8a8092c3f1c761d8c9292065ed6b6698786bb966da4dab9';

const PGBOUNCER_PORT = 6432;

export interface PgBouncerOptions {
  /** The harness database's URL; its user and password are the ones the pooler logs in with. */
  readonly databaseUrl: string;
  /** Server connections per database and user: fewer than the clients is what makes them shared. */
  readonly serverConnections: number;
}

export interface PgBouncer {
  /** `databaseUrl` with the pooler's host and port in place of the database's. */
  pooled(databaseUrl: string): string;
  stop(): Promise<void>;
}

/**
 * A PgBouncer in transaction pooling in front of the harness's Postgres. It
 * reaches Postgres at {@link E2E_DATABASE_CONTAINER_ADDRESS_VAR}, since the host
 * in `DATABASE_URL` means the pooler's own container from inside it.
 *
 * `query_wait_timeout` is cut from its 120s default to 30s: a client queued for
 * a server connection is then dropped well inside the suite's test timeout.
 */
export async function startPgBouncer(options: PgBouncerOptions): Promise<PgBouncer> {
  const address = process.env[E2E_DATABASE_CONTAINER_ADDRESS_VAR];
  if (!address) {
    throw new Error(
      `${E2E_DATABASE_CONTAINER_ADDRESS_VAR} is not set. The e2e globalSetup sets it for the Postgres container it ` +
        'starts; with BGE_E2E_DATABASE_URL, set it to the host:port a container reaches that database at.',
    );
  }
  // Parsed as a URL's authority, so an IPv6 address in brackets keeps its colons.
  const postgres = new URL(`postgres://${address}`);
  const url = new URL(options.databaseUrl);

  const config = [
    '[databases]',
    `* = host=${postgres.hostname.replace(/^\[(.*)\]$/, '$1')} port=${postgres.port || '5432'}`,
    '',
    '[pgbouncer]',
    'listen_addr = 0.0.0.0',
    `listen_port = ${PGBOUNCER_PORT}`,
    'auth_type = scram-sha-256',
    'auth_file = /etc/pgbouncer/userlist.txt',
    'pool_mode = transaction',
    `default_pool_size = ${options.serverConnections}`,
    'query_wait_timeout = 30',
    '',
  ].join('\n');

  const container: StartedTestContainer = await new GenericContainer(PGBOUNCER_IMAGE)
    .withCopyContentToContainer([
      { content: config, target: '/etc/pgbouncer/pgbouncer.ini' },
      {
        content: `${quoted(decodeURIComponent(url.username))} ${quoted(decodeURIComponent(url.password))}\n`,
        target: '/etc/pgbouncer/userlist.txt',
      },
    ])
    .withExposedPorts(PGBOUNCER_PORT)
    .withWaitStrategy(Wait.forLogMessage(/process up/))
    .start();

  return {
    pooled: (databaseUrl) => {
      const pooled = new URL(databaseUrl);
      pooled.hostname = container.getHost();
      pooled.port = String(container.getMappedPort(PGBOUNCER_PORT));
      return pooled.toString();
    },
    stop: async () => {
      await container.stop();
    },
  };
}

/** A userlist.txt field: double-quoted, with a double quote written twice. */
function quoted(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
