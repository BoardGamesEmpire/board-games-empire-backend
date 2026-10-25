import { isPrismaUniqueConstraintError } from './prisma-errors';

/**
 * A client request id as the row stores it, or `undefined` for no key (#252).
 *
 * A blank key is not a key. The DTOs reject one over HTTP, but every keyed
 * create is also callable in-process, where no validation runs; persisting ''
 * would put every keyless in-process create by a user into one bucket, and the
 * second would replay the first. Trimmed so both entry points agree on the
 * bucket: the DTOs trim too, so a padded retry can't split into two rows.
 */
export function normalizeClientRequestId(raw: string | null | undefined): string | undefined {
  return raw?.trim() || undefined;
}

export interface KeyedCreateLogger {
  warn(message: string): void;
  debug(message: string): void;
}

export interface KeyedCreateOptions<T> {
  /** Already normalized. `undefined` runs `create` unkeyed and never replays. */
  readonly clientRequestId: string | undefined;
  /** The row under (acting creator, key), ignoring soft-delete. */
  readonly find: (clientRequestId: string) => Promise<T | null>;
  readonly create: () => Promise<T>;
  readonly logger: KeyedCreateLogger;
  /** Names the write in log lines, e.g. 'household create'. */
  readonly label: string;
}

export interface KeyedCreateResult<T> {
  readonly row: T;
  readonly replayed: boolean;
}

/**
 * A create a client may retry, keyed by its client request id (#252): returns
 * the row the key already names, or the row this create makes.
 *
 * 1. Look up the row under the key. If there is one, it is a replay.
 * 2. Otherwise run the create.
 * 3. On a unique violation, look up again. That is a concurrent duplicate: both
 *    requests missed step 1, and this insert waited on the other's uncommitted
 *    unique entry until it committed.
 * 4. A unique violation with no row under the key is logged at warn and the
 *    original error rethrown.
 *
 * The lookup runs first, before any check the create makes. A replay exists
 * because the original's response was lost, so its answer must be the
 * original's; catching first instead lets a check that has changed since (a
 * household soft-deleted, a household grant revoked, an invitee who now blocks
 * the creator) turn the replay into a 403 or 404. A check the route makes
 * before the service runs still refuses a replay: a user banned from a kind of
 * create since is refused its retry too, so a key is never a way around a ban
 * (#251).
 *
 * The row decides, not the error's shape. Under Prisma 7 with the `PrismaPg`
 * adapter a P2002's `meta.target` is empty (#257), so matching it against the
 * constraint's name never fired and every keyed retry answered 500. A row under
 * the key means this key's create committed, whatever the database says about
 * which index tripped. Warn, not debug, on the miss: production drops debug,
 * and this is the branch that turns a legitimate retry back into a 500. The
 * whole `meta` is logged because `target` being absent is what hid the last
 * defect.
 *
 * `create` must not run inside a transaction the caller holds open. Postgres
 * aborts a transaction on a constraint violation, so step 3's lookup would fail
 * in it. A create that needs one opens its own inside the callback.
 *
 * Which side effects run on a replay (an eviction, an emit, a notification) is
 * the caller's to decide from `replayed`; the helper knows no aggregate's.
 */
export async function createOrReplay<T extends { readonly id: string }>(
  options: KeyedCreateOptions<T>,
): Promise<KeyedCreateResult<T>> {
  const { clientRequestId, find, create, logger, label } = options;

  if (clientRequestId === undefined) {
    return { row: await create(), replayed: false };
  }

  const existing = await find(clientRequestId);

  if (existing) {
    logger.debug(`Replay of ${label}; returning ${existing.id}`);

    return { row: existing, replayed: true };
  }

  try {
    return { row: await create(), replayed: false };
  } catch (error) {
    if (!isPrismaUniqueConstraintError(error)) {
      throw error;
    }

    const winner = await find(clientRequestId);

    if (!winner) {
      logger.warn(
        `Keyed ${label} raised P2002 with no row under the key; meta=${JSON.stringify(error.meta)}. Rethrowing.`,
      );

      throw error;
    }

    logger.debug(`Replay of ${label} after a concurrent duplicate; returning ${winner.id}`);

    return { row: winner, replayed: true };
  }
}
