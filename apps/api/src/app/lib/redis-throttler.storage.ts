import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import type { Redis } from 'iovalkey';
import { createHash } from 'node:crypto';

/**
 * Namespace for every throttler key, so buckets are identifiable in a shared
 * database.
 *
 * IDENTIFIABLE, NOT ISOLATED, and the difference is reachable. The prefix is
 * fixed, so two BGE deployments pointed at one logical database share buckets
 * outright: same route handler, same tracker value, same key. The supported
 * escape hatch gets there — `BGE_E2E_REDIS_URL` aimed at a Redis a dev API is
 * already using puts both on database 0, and every request in a suite run comes
 * from `127.0.0.1`, so the test traffic and the dev API draw down one budget.
 *
 * Deliberately not fixed by namespacing this prefix, because throttle buckets
 * are the newest of four things that collide in that configuration and the
 * least costly of them: the same database carries better-auth's sessions
 * (`api:cache:auth_*`), the cached ability graphs
 * (`api:cache:bge:user:permissions:*`), and the bootstrap advisory lock
 * (`bge:bootstrap`). A throttle-only namespace would leave sessions and
 * permission graphs shared while making the arrangement look isolated, which is
 * worse than a collision everyone can see. What that configuration actually
 * wants is a per-run prefix across the whole harness — the isolation #341's
 * own description assumed was already in place, and which does not exist.
 */
const KEY_PREFIX = 'bge:throttle';

/**
 * Counts one hit and reports where the caller stands.
 *
 * KEYS[1] is the hit counter, KEYS[2] the block marker. Two keys rather than
 * one because they carry different deadlines: the counter's TTL is the window,
 * the marker's is the block duration.
 *
 * The block is capped at the counter's remaining TTL, so refusal never outlasts
 * the window that caused it. Without the cap a block set near the end of a
 * window runs past the counter's own expiry and into the next window, which is
 * both longer than any configured value and impossible to reason about from the
 * outside.
 *
 * A blocked caller is not counted, and the early return is deliberate in a
 * second way. It keeps `totalHits` bounded for exactly the caller hammering
 * hardest — the one whose key we least want growing — and it means a block
 * expiring does NOT hand back a fresh budget. The library's own storages do the
 * opposite: both zero the hit counter on block expiry, which is what makes
 * `blockDuration` shorter than `ttl` multiply the effective limit there. Here
 * the hit key keeps its own expiry, so a caller who trips the limit is refused
 * until the WINDOW ends regardless of how short the block is. See the
 * `blockDuration` note in `throttlers.ts` for what that means for the values we
 * pick.
 *
 * FIXED WINDOW, not rolling: `PEXPIRE` is set on the first hit of a window and
 * not touched again, so the window starts at a caller's first request and
 * clears whole. This is the ordinary shape for a Redis limiter (and what
 * `@nest-lab/throttler-storage-redis` does), but it IS a change from the
 * in-memory storage's per-hit decrement — see the note on
 * `FEEDBACK_USER_THROTTLE_LIMIT`.
 */
const INCREMENT_SCRIPT = `
local hitKey = KEYS[1]
local blockKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])

local blockTtl = redis.call('PTTL', blockKey)
if blockTtl > 0 then
  local held = tonumber(redis.call('GET', hitKey))
  local heldTtl = redis.call('PTTL', hitKey)
  -- The block is capped at the hit key's remaining life but written a moment
  -- later, so it can outlive it by the width of that gap. A block with no
  -- counter behind it is stale: the window that justified it is over. Drop it
  -- and count this request normally rather than reporting a refusal from
  -- numbers nothing read.
  if held == nil or heldTtl <= 0 then
    redis.call('DEL', blockKey)
  else
    return { held, heldTtl, 1, blockTtl }
  end
end

local totalHits = redis.call('INCR', hitKey)
local timeToExpire = redis.call('PTTL', hitKey)
if timeToExpire <= 0 then
  redis.call('PEXPIRE', hitKey, ttl)
  timeToExpire = ttl
end

if totalHits > limit then
  -- Capped at what is left of the window. Uncapped, a caller tripping at 59:00
  -- of a one-hour window would carry a block to 1:59:00 -- past the expiry of
  -- the counter that justified it, eating a window they never spent.
  local block = blockDuration
  if block > timeToExpire then
    block = timeToExpire
  end
  redis.call('SET', blockKey, 1, 'PX', block)
  return { totalHits, timeToExpire, 1, block }
end

return { totalHits, timeToExpire, 0, 0 }
`;

/** Milliseconds to whole seconds, rounding UP — see the `timeToExpire` spec. */
const toSeconds = (ms: number): number => Math.ceil(Math.max(ms, 0) / 1000);

/**
 * How long a single counter round-trip may take before the request is let
 * through.
 *
 * `maxRetriesPerRequest: 3` on the cache client bounds a DISCONNECTED client; it
 * does nothing for a connected one that has stopped answering — a failover in
 * progress, a server blocked on a slow command, a blackholed route. Without a
 * deadline that case never rejects, so the fail-open path below is unreachable
 * and every request instead parks inside `ThrottlerGuard.canActivate`. Since the
 * IP tier runs on every route, that is the whole API stalling on the rate
 * limiter — the precise outcome failing open exists to prevent.
 *
 * Generous against a local Redis answering in under a millisecond, and short
 * enough that a hung one costs a request rather than a process.
 */
const COMMAND_DEADLINE_MS = 250;

/** Quietest useful cadence for the fail-open log — see `reportFailure`. */
const FAILURE_LOG_INTERVAL_MS = 10_000;

/**
 * Shared between a request's deadline and the work that deadline bounds, so the
 * work can tell that nothing is waiting for it any more. See `withDeadline` for
 * what the deadline can and cannot stop, and `run` for the one decision that
 * turns on this flag.
 */
interface Deadline {
  expired: boolean;
}

/**
 * Shared rate-limit counters, backed by the cache Redis (#341).
 *
 * Replaces `@nestjs/throttler`'s default in-process `Map`, under which limits
 * multiplied by replica count and every deploy handed every caller a fresh
 * budget. Neither was visible until #293 made the window a real one.
 *
 * WHY NOT `@nest-lab/throttler-storage-redis`. It would be a shorter file, but
 * it is typed against `ioredis` — constructor and `redis` field both — while
 * `@bge/redis` hands out `iovalkey` clients, so using it means a cast past an
 * unsatisfied peer dependency. The interface it implements is a single method
 * and its script is the twenty lines above, so owning it costs little and buys
 * the fail-open policy below being ours to state rather than inherited.
 * `docs/REDIS.md` carries the connection story.
 *
 * NOT A NEST PROVIDER, deliberately. `ThrottlerModule.forRootAsync`'s factory
 * needs the storage while building its options, so `AppModule` constructs this
 * with `new` and hands it the injected cache client. It carries no `@Injectable`
 * or `@Inject` for that reason: decorators here would promise a lifecycle that
 * never runs, so an `OnModuleDestroy` or a second constructor dependency added
 * later would be silently dead.
 *
 * FAILS OPEN (D-341-3). If Redis cannot answer — or cannot answer promptly —
 * the request is allowed and the failure is logged. Rate limiting is an abuse
 * control, not a correctness control: failing closed would turn a Redis blip
 * into a 429 on every route of every replica at once. The tradeoff is stated
 * rather than inherited, which is what #341 asked for.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  /** `EVALSHA` digest of {@link INCREMENT_SCRIPT}; see `run`. */
  private readonly scriptSha = createHash('sha1').update(INCREMENT_SCRIPT).digest('hex');

  /** Fail-open bookkeeping, so an outage is one log line and not one per request. */
  private failuresSinceLastLog = 0;
  private lastFailureLogAt = 0;

  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitKey = `${KEY_PREFIX}:${throttlerName}:${key}`;
    const deadline: Deadline = { expired: false };

    try {
      const reply = await this.withDeadline(
        this.run(hitKey, `${hitKey}:blocked`, ttl, limit, blockDuration, deadline),
        deadline,
      );

      // Validated BEFORE recovery is declared. A reply this cannot read is a
      // failure, not a recovery, and `noteRecovery` running first would clear
      // the log gate on every request and then log the failure again straight
      // after — two lines per request for as long as the drift lasts, which is
      // the storm the gate exists to prevent.
      const record = this.toRecord(reply);

      this.noteRecovery();

      return record;
    } catch (cause) {
      this.reportFailure(cause, throttlerName);

      return this.allow(ttl);
    }
  }

  /**
   * Sends the digest rather than the script.
   *
   * This runs on every request of every route, so shipping the ~1 KB body each
   * time is a kilobyte of identical text per request for Redis to re-read.
   * `EVALSHA` sends forty hex characters instead. A server that has not seen the
   * script — first call after boot, or after a `SCRIPT FLUSH` — answers
   * `NOSCRIPT`, and the `EVAL` fallback both satisfies that request and caches
   * the script for the next one.
   *
   * WHAT A RECONNECT DOES TO THIS. The script is not idempotent — it `INCR`s —
   * and the client underneath is the shared cache connection, which runs
   * iovalkey's default `autoResendUnfulfilledCommands: true`. Nothing in
   * `toIoRedisOptions` overrides it. So a command already on the wire when the
   * connection drops is resent verbatim on reconnect, and if the server had in
   * fact run it before the socket died, that caller is charged twice for one
   * request.
   *
   * The error leans the wrong way. Everything else here fails OPEN — an
   * unreachable counter allows the request — while this fails CLOSED, refusing
   * a caller below the configured limit on hits they never made. It is narrow
   * (it needs a disconnect inside the gap between execution and reply) but it
   * is not theoretical: every failover is an opportunity, and a failover is
   * also when the deadline below has already fail-opened the same requests.
   *
   * Left alone rather than fixed in place, because both fixes are wider than
   * this method. Turning resending off belongs to the client, and this one is
   * shared with the app cache, the gateway's config pub/sub and the health
   * indicator, none of which asked for that. Making the script idempotent needs
   * a per-request token and somewhere to remember it, which is a second
   * keyspace with its own expiry. The isolated limiter connection that
   * `withDeadline` already argues for would take this with it.
   */
  private async run(
    hitKey: string,
    blockKey: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    deadline: Deadline,
  ): Promise<unknown> {
    const args = [2, hitKey, blockKey, ttl, limit, blockDuration] as const;

    try {
      return await this.redis.call('evalsha', this.scriptSha, ...args);
    } catch (cause) {
      if (!isNoScriptError(cause)) {
        throw cause;
      }

      // A `NOSCRIPT` that arrives after the deadline answers a request that was
      // already allowed through. Sending the `EVAL` anyway would run the script
      // a SECOND time for that one request — charging the caller's counter
      // twice — and nothing is left waiting to read the result. The slow path
      // is exactly where this happens: a server that takes longer than the
      // deadline to answer and then answers `NOSCRIPT`, which is a failover to
      // a node with a cold script cache.
      if (deadline.expired) {
        throw cause;
      }

      return this.redis.call('eval', INCREMENT_SCRIPT, ...args);
    }
  }

  /**
   * Rejects if the counter has not answered within {@link COMMAND_DEADLINE_MS},
   * and marks `deadline` so the work behind it can stop making new decisions.
   *
   * WHAT THIS DOES NOT DO: cancel the command. Once `EVALSHA` is on the wire the
   * server will run it whenever it gets to it, and no client-side timeout can
   * take that back. Two consequences, and the second is the one that bites.
   *
   * Every request during a stall adds another command to the SHARED cache
   * client's queue, and nothing bounds that queue — so a long outage at any real
   * request rate grows it until the process feels it, and the app cache and
   * health indicator are queued behind it.
   *
   * And the counting is not merely late. The whole stall's worth of commands
   * lands at recovery, which is when the first of them sets `PEXPIRE` — so the
   * window starts at recovery and is immediately full of traffic that was
   * already allowed through. A caller told its budget was untouched for the
   * length of the outage is blocked for a fresh window the moment the outage
   * ends, which inverts the fail-open policy at the worst possible moment.
   *
   * The fix is to stop dispatching once the backend is known-hung — a circuit
   * breaker, or an isolated client whose depth can be capped without touching
   * cache reads — and it is deliberately not attempted here, because it changes
   * behaviour under outage and wants reviewing on its own.
   */
  private withDeadline<T>(work: Promise<T>, deadline: Deadline): Promise<T> {
    let timer: NodeJS.Timeout;

    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        deadline.expired = true;
        reject(new Error(`Rate-limit storage did not answer within ${COMMAND_DEADLINE_MS}ms`));
      }, COMMAND_DEADLINE_MS);
    });

    return Promise.race([work, expiry]).finally(() => clearTimeout(timer)) as Promise<T>;
  }

  /**
   * The script returns four integers. Anything else means the script and this
   * file have drifted apart, which is a deploy problem rather than a request
   * problem — so it throws into the same catch an unreachable server lands in,
   * and the request is allowed on the same reasoning.
   *
   * Throwing rather than failing open in place is what keeps the log gate
   * honest: one path reports failures, so a run of malformed replies is one
   * line per interval like any other outage, and it carries the throttler name
   * rather than a placeholder.
   */
  private toRecord(reply: unknown): ThrottlerStorageRecord {
    if (!Array.isArray(reply) || reply.length !== 4 || reply.some((field) => typeof field !== 'number')) {
      throw new Error(`Rate-limit script returned an unreadable record: ${JSON.stringify(reply)}`);
    }

    const [totalHits, timeToExpire, isBlocked, timeToBlockExpire] = reply as number[];

    return {
      totalHits,
      timeToExpire: toSeconds(timeToExpire),
      isBlocked: isBlocked === 1,
      timeToBlockExpire: toSeconds(timeToBlockExpire),
    };
  }

  /**
   * Logs the first failure immediately and then at most one line per interval,
   * carrying the count suppressed since the last one.
   *
   * Ungated, this is one error per request for the length of the outage — at a
   * few hundred requests a second that is tens of thousands of serialized stacks
   * competing with the logs an operator is trying to read during the incident
   * that produced them.
   */
  private reportFailure(cause: unknown, throttlerName: string): void {
    this.failuresSinceLastLog++;

    const now = Date.now();
    if (this.lastFailureLogAt !== 0 && now - this.lastFailureLogAt < FAILURE_LOG_INTERVAL_MS) {
      return;
    }

    const suppressed = this.failuresSinceLastLog - 1;
    this.lastFailureLogAt = now;
    this.failuresSinceLastLog = 0;

    this.logger.error(
      { err: cause, throttlerName, suppressedSinceLastLog: suppressed },
      'Rate-limit storage unavailable; allowing requests through (fail-open, see class docstring)',
    );
  }

  /** Closes an outage in the log, so the next one is reported immediately. */
  private noteRecovery(): void {
    if (this.lastFailureLogAt === 0) {
      return;
    }

    const suppressed = this.failuresSinceLastLog;
    this.lastFailureLogAt = 0;
    this.failuresSinceLastLog = 0;

    this.logger.log(
      { suppressedSinceLastLog: suppressed },
      'Rate-limit storage is answering again; limits are being enforced',
    );
  }

  /**
   * The reply that lets a request through.
   *
   * `totalHits: 0` is not a neutral value — the guard writes
   * `X-RateLimit-Remaining` as `limit - totalHits`, so for the length of an
   * outage every client is told its budget is untouched. That is the honest
   * reading of fail-open (nothing is being counted, so nothing has been spent)
   * and it is deliberately optimistic: a client that trusts it will keep
   * sending, which is what allowing the request already decided.
   */
  private allow(ttl: number): ThrottlerStorageRecord {
    return { totalHits: 0, timeToExpire: toSeconds(ttl), isBlocked: false, timeToBlockExpire: 0 };
  }
}

/** Redis answers `NOSCRIPT` when an `EVALSHA` digest is not in its script cache. */
function isNoScriptError(cause: unknown): boolean {
  return cause instanceof Error && cause.message.includes('NOSCRIPT');
}
