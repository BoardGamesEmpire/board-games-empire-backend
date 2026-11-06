import { DatabaseService, EXTENDED_NETWORK_STEPS, Prisma } from '@bge/database';
import { Injectable, Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';

/** What a rebuild changed, for the logs and for #497's measurement. */
export interface ExtendedNetworkRebuildResult {
  /** Rows deleted: pairs no longer within three friendship steps. */
  readonly removed: number;
  /** Rows inserted, plus rows whose `steps` changed. A row left as it was isn't counted. */
  readonly written: number;
}

/** What one batch of a full rebuild changed, and where the next one starts. */
export interface ExtendedNetworkBatchResult extends ExtendedNetworkRebuildResult {
  /** The last user the batch rebuilt from; the next batch starts after them. Null once no user is left. */
  readonly next: string | null;
}

/**
 * How many users one batch of a full rebuild walks from. A batch holds the
 * lock for its own transaction only, so a change's rebuild waits for at most
 * one batch, not the whole run. Measured on #497 at 30 friends a user, a
 * source costs about 13 ms, so a batch about 2.6 s. Each batch reads the
 * accepted friendships once more, which a smaller batch would repeat more
 * often.
 */
export const REBUILD_ALL_BATCH_SIZE = 200;

/** The counts the statement returns. Postgres counts in `bigint`. */
interface RebuildCounts {
  readonly removed: bigint;
  readonly written: bigint;
  /** From a batch of a full rebuild: its last source, and how many sources it had. */
  readonly last_user_id?: string | null;
  readonly sources?: bigint;
}

/** The advisory lock every rebuild holds for its transaction. */
const EXTENDED_NETWORK_LOCK_NAME = 'extended-network';

const EXTENDED_NETWORK_LOCK = Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${EXTENDED_NETWORK_LOCK_NAME}, 0))`;

/**
 * How long a rebuild's transaction may run, the wait for the lock included. A
 * rebuild waits behind any other, and one around a user with hundreds of
 * friends walks from most of a large server, far longer than Prisma's
 * five-second default.
 */
const REBUILD_TRANSACTION_TIMEOUT_MS = 10 * 60 * 1000;

/** The furthest a row reaches, and the furthest a rebuild's sources sit from the change. */
const MAX_STEPS = Prisma.raw(String(EXTENDED_NETWORK_STEPS));
const SOURCE_STEPS = Prisma.raw(String(EXTENDED_NETWORK_STEPS - 1));

/**
 * The accepted friendships as steps, both directions of each pair's single
 * row, read once per statement for the walk to join by hash. A pending,
 * declined, withdrawn or blocked row is no step.
 *
 * Measured on #497: two index lookups per user per step made most of a
 * rebuild, about 1.2M of them for one change at 30 friends a user, against
 * 30,000 accepted friendships. Reading them once halved the rebuild for the
 * same rows. On a server with millions of friendships the read becomes much
 * of a rebuild's cost.
 */
const ADJACENCY = Prisma.sql`adj(a, other) AS MATERIALIZED (
  SELECT requester_id, addressee_id FROM friendships WHERE status = 'Accepted'
  UNION ALL
  SELECT addressee_id, requester_id FROM friendships WHERE status = 'Accepted'
)`;

/**
 * Given a `sources` CTE, computes every source's pairs and writes only the
 * differences. It reads the rows `scope` names (a predicate on
 * `extended_network un`) once, compares them with the fresh pairs, then deletes
 * the pairs gone and upserts the pairs that are new or whose `steps` moved.
 * A row whose `steps` stayed is neither rewritten nor locked. An upsert over
 * every fresh pair would lock each existing row it met, a header write and a
 * WAL record per pair, even where its `WHERE` then left the row as it was.
 * `extra` adds columns to the statement's one result row.
 *
 * The delete and the upsert, which share one snapshot, touch disjoint keys:
 * `gone` holds only pairs missing from `fresh`, and `changed` only pairs in
 * it, so the two never meet on a row. `gone` is materialized so the delete
 * looks up only the pairs gone; inlined, Postgres joined every existing row
 * to the table before the anti-join emptied the set.
 */
function writeFreshPairs(scope: Prisma.Sql, extra: Prisma.Sql = Prisma.empty): Prisma.Sql {
  return Prisma.sql`walk(source, other, steps) AS (
  SELECT s.user_id, s.user_id, 0 FROM sources s
  UNION
  SELECT w.source, step.other, w.steps + 1
  FROM walk w
  JOIN adj step ON step.a = w.other
  WHERE w.steps < ${MAX_STEPS}
),
fresh AS (
  SELECT source AS user_id, other AS other_user_id, MIN(steps) AS steps
  FROM walk
  WHERE other <> source
  GROUP BY source, other
),
existing AS MATERIALIZED (
  SELECT un.user_id, un.other_user_id, un.steps FROM extended_network un WHERE ${scope}
),
gone AS MATERIALIZED (
  SELECT e.user_id, e.other_user_id
  FROM existing e
  WHERE NOT EXISTS (SELECT 1 FROM fresh f WHERE f.user_id = e.user_id AND f.other_user_id = e.other_user_id)
),
changed AS (
  SELECT f.user_id, f.other_user_id, f.steps
  FROM fresh f
  LEFT JOIN existing e ON e.user_id = f.user_id AND e.other_user_id = f.other_user_id
  WHERE e.steps IS DISTINCT FROM f.steps
),
removed AS (
  DELETE FROM extended_network un
  USING gone g
  WHERE un.user_id = g.user_id AND un.other_user_id = g.other_user_id
  RETURNING 1
),
written AS (
  INSERT INTO extended_network (user_id, other_user_id, steps)
  SELECT user_id, other_user_id, steps FROM changed
  ON CONFLICT (user_id, other_user_id) DO UPDATE SET steps = EXCLUDED.steps
  RETURNING 1
)
SELECT (SELECT count(*) FROM removed) AS removed, (SELECT count(*) FROM written) AS written${extra}`;
}

/**
 * The rows a friendship change at `userId` can move. Its sources are every
 * user within two steps of `userId`. A pair whose fewest steps the change
 * moved has a path of at most three steps through the changed friendship,
 * before the change or after it, so each end of the pair is within two steps
 * of one of the friendship's two users, by a path that doesn't use it. The
 * job for each user of the friendship covers that user's side.
 */
function rebuildAroundStatement(userId: string): Prisma.Sql {
  return Prisma.sql`WITH RECURSIVE ${ADJACENCY},
near(user_id, steps) AS (
  SELECT ${userId}::text, 0
  UNION
  SELECT step.other, n.steps + 1
  FROM near n
  JOIN adj step ON step.a = n.user_id
  WHERE n.steps < ${SOURCE_STEPS}
),
sources AS (SELECT DISTINCT user_id FROM near),
${writeFreshPairs(Prisma.sql`un.user_id IN (SELECT user_id FROM sources)`)}`;
}

/**
 * One batch of a full rebuild: the rows of the next users by id after
 * `after`, from the start when it is null. Every user is a source, not only
 * those with a friendship, so a user left with none loses their rows. The
 * batches follow the primary key, so each finds its users by the index.
 */
function rebuildAllBatchStatement(after: string | null): Prisma.Sql {
  const from = after === null ? Prisma.empty : Prisma.sql`WHERE u.id > ${after}`;

  return Prisma.sql`WITH RECURSIVE ${ADJACENCY},
sources AS MATERIALIZED (
  SELECT u.id AS user_id FROM users u ${from} ORDER BY u.id LIMIT ${Prisma.raw(String(REBUILD_ALL_BATCH_SIZE))}
),
${writeFreshPairs(
  Prisma.sql`un.user_id IN (SELECT user_id FROM sources)`,
  Prisma.sql`, (SELECT user_id FROM sources ORDER BY user_id DESC LIMIT 1) AS last_user_id, (SELECT count(*) FROM sources) AS sources`,
)}`;
}

/**
 * Keeps the extended network table current: who is within three accepted
 * friendship steps of whom, with the fewest steps (#497). A worker job runs
 * it a few seconds after each friendship change that adds or ends an accepted
 * friendship, and in full, in batches, when the worker starts and daily. No
 * request waits on it.
 *
 * - Every rebuild holds one advisory lock for its transaction, and runs Read
 *   Committed, so its statement reads the friendships only after any earlier
 *   rebuild committed. A later rebuild therefore never writes an older state
 *   over a newer one. The queue runs one rebuild at a time across workers, so
 *   the lock is rarely waited on. A full rebuild runs in batches, each its
 *   own transaction, and a change's rebuild runs between two of them, so it
 *   waits for one batch at most.
 * - Only `Accepted` friendships are steps. Blocks aren't stored here: the
 *   permissions that read the table check them against the friendships, so a
 *   block takes effect before any job runs. If a block stops ending a
 *   friendship (#694), the walk has to leave the blocked pair out.
 * - Deleting a user cascades the rows that name them. A pair whose only path
 *   went through them keeps its row until the daily rebuild.
 */
@Injectable()
export class ExtendedNetworkService {
  private readonly logger = new Logger(ExtendedNetworkService.name);

  constructor(private readonly db: DatabaseService) {}

  /** Rewrites the rows of every user within two friendship steps of `userId`. */
  async rebuildAround(userId: string): Promise<ExtendedNetworkRebuildResult> {
    const started = performance.now();
    const { removed, written } = await this.rebuild(rebuildAroundStatement(userId));

    this.logger.debug(
      `Rebuilt the extended network rows around user ${userId} in ${Math.round(performance.now() - started)} ms: ` +
        `${removed} removed, ${written} written`,
    );

    return { removed, written };
  }

  /**
   * Rewrites the rows of the next {@link REBUILD_ALL_BATCH_SIZE} users by id
   * after `after`, from the first user when it is null. A full rebuild is
   * every batch in turn, each starting after the last one's `next`, until
   * `next` is null.
   */
  async rebuildAllBatch(after: string | null): Promise<ExtendedNetworkBatchResult> {
    const started = performance.now();
    const { removed, written, lastUserId, sources } = await this.rebuild(rebuildAllBatchStatement(after));
    // A batch short of the size took the last users there are.
    const next = sources < REBUILD_ALL_BATCH_SIZE ? null : (lastUserId ?? null);

    this.logger.debug(
      `Rebuilt a batch of the extended network rows after user ${after ?? '(the first)'} in ` +
        `${Math.round(performance.now() - started)} ms: ${removed} removed, ${written} written` +
        (next === null ? '; no users left' : `; the next batch starts after user ${next}`),
    );

    return { removed, written, next };
  }

  private async rebuild(
    statement: Prisma.Sql,
  ): Promise<ExtendedNetworkRebuildResult & { readonly lastUserId?: string | null; readonly sources: number }> {
    const [counts] = await this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw(EXTENDED_NETWORK_LOCK);

        return tx.$queryRaw<RebuildCounts[]>(statement);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: REBUILD_TRANSACTION_TIMEOUT_MS },
    );

    return {
      removed: Number(counts?.removed ?? 0),
      written: Number(counts?.written ?? 0),
      lastUserId: counts?.last_user_id,
      sources: Number(counts?.sources ?? 0),
    };
  }
}
