import { DatabaseService, type SafeHttpPolicy } from '@bge/database';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  SAFE_HTTP_DEFAULT_MAX_REDIRECTS,
  SAFE_HTTP_DEFAULT_STRICT_MODE,
  SAFE_HTTP_DEFAULT_TIMEOUT_MS,
  SAFE_HTTP_POLICY_REFRESH_INTERVAL_MS,
  SAFE_HTTP_POLICY_REFRESH_INTERVAL_NAME,
} from '../constants/safe-http.constants';
import type { SafeHttpPolicySnapshot } from '../interfaces/safe-http-policy-snapshot.interface';
import { parseCidr } from '../ip/cidr';
import { SafeHttpPolicyEventsService } from './safe-http-policy-events.service';

/**
 * Holder of the in-memory `SafeHttpPolicy` snapshot consumed by
 * `IpPolicyService` and `SafeHttpService`. Loads the singleton row from DB
 * on module init, refreshes on Redis pub/sub events, and re-reads on a
 * periodic backstop interval (see `refreshOnInterval`) to recover from any
 * pub/sub message missed during a transient Redis disconnect.
 *
 * Concurrency model: readers call `current()` which returns the current
 * snapshot reference. `refresh()` swaps the reference atomically; a reader
 * mid-request either sees the old snapshot or the new, never partial. Each
 * snapshot is frozen with `Object.freeze` so accidental writes from
 * downstream code throw in strict mode and fail in dev fast.
 *
 * Failure modes:
 *   - DB read fails on boot → fall back to the conservative default
 *     snapshot (no allowlists). Log loudly. Self-hosters with internal
 *     CIDRs configured will see traffic fail immediately, which is the
 *     correct failure direction — fail-safe means failing toward more
 *     restriction, not less.
 *   - DB read fails on refresh → retain prior snapshot. The next event
 *     will trigger another refresh attempt.
 *   - Subscribed event handler throws → caught by `SafeHttpPolicyEventsService`,
 *     logged, and the message is dropped. No crash propagation.
 */
@Injectable()
export class SafeHttpPolicyService implements OnModuleInit {
  private readonly logger = new Logger(SafeHttpPolicyService.name);
  private snapshot: SafeHttpPolicySnapshot = makeDefaultSnapshot();

  constructor(
    private readonly db: DatabaseService,
    private readonly events: SafeHttpPolicyEventsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    await this.events.subscribe(async () => {
      await this.refresh();
    });
  }

  /**
   * Returns the currently loaded snapshot. Always a complete, internally
   * consistent view; never observes mid-refresh state.
   */
  current(): SafeHttpPolicySnapshot {
    return this.snapshot;
  }

  /**
   * Periodic backstop: re-reads the snapshot on a fixed cadence so a pub/sub
   * message missed during a transient Redis disconnect is recovered within
   * one interval. Only fires in apps that register `ScheduleModule.forRoot()`
   * (api, worker); elsewhere the decorator is an inert no-op. `refresh()` is
   * idempotent and swallows its own errors, so a tick can never crash the
   * scheduler.
   */
  @Interval(SAFE_HTTP_POLICY_REFRESH_INTERVAL_NAME, SAFE_HTTP_POLICY_REFRESH_INTERVAL_MS)
  async refreshOnInterval(): Promise<void> {
    await this.refresh();
  }

  /**
   * Re-read the singleton row from DB and swap the snapshot. Idempotent;
   * safe to call from event handlers and admin tooling.
   *
   * Public surface so admin tooling and tests can trigger a refresh
   * directly without going through pub/sub.
   */
  async refresh(): Promise<void> {
    try {
      const row = await this.db.safeHttpPolicy.findUnique({ where: { singleton: true } });

      this.snapshot = row ? this.normalize(row) : makeDefaultSnapshot();
      this.logger.debug('SafeHttpPolicy snapshot refreshed');
    } catch (err) {
      this.logger.error(
        `Failed to refresh SafeHttpPolicy snapshot — retaining existing snapshot: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  /**
   * Convert a Prisma row into the read-only snapshot shape consumed by the
   * evaluator. Hostnames are lower-cased once here so per-request matching
   * stays case-blind without repeated normalization. CIDR strings that
   * fail to parse are dropped with a warn log — the admin controller's DTO
   * validation should have rejected them at write time, but this is
   * defense in depth against direct DB mutations or migration anomalies.
   */
  private normalize(row: SafeHttpPolicy): SafeHttpPolicySnapshot {
    return Object.freeze({
      defaultTimeoutMs: row.defaultTimeoutMs,
      defaultMaxRedirects: row.defaultMaxRedirects,
      strictMode: row.strictMode,
      allowedHosts: Object.freeze(row.allowedHosts.map((h) => h.toLowerCase())),
      allowedCidrs: Object.freeze(this.filterValidCidrs(row.allowedCidrs, 'allowedCidrs')),
      blockedHosts: Object.freeze(row.blockedHosts.map((h) => h.toLowerCase())),
      blockedCidrs: Object.freeze(this.filterValidCidrs(row.blockedCidrs, 'blockedCidrs')),
    });
  }

  private filterValidCidrs(input: readonly string[], field: string): string[] {
    const valid: string[] = [];
    for (const entry of input) {
      if (parseCidr(entry) !== null) {
        valid.push(entry);
      } else {
        this.logger.warn(`Skipping invalid CIDR in SafeHttpPolicy.${field}: "${entry}"`);
      }
    }

    return valid;
  }
}

/**
 * Conservative fallback used before DB load completes and when DB load fails.
 * No allowlists; default private-range deny applies in full. Strict mode on.
 * These are the safest possible defaults — any deployment that needs looser
 * behavior must explicitly configure it.
 */
function makeDefaultSnapshot(): SafeHttpPolicySnapshot {
  return Object.freeze({
    defaultTimeoutMs: SAFE_HTTP_DEFAULT_TIMEOUT_MS,
    defaultMaxRedirects: SAFE_HTTP_DEFAULT_MAX_REDIRECTS,
    strictMode: SAFE_HTTP_DEFAULT_STRICT_MODE,
    allowedHosts: Object.freeze([] as readonly string[]),
    allowedCidrs: Object.freeze([] as readonly string[]),
    blockedHosts: Object.freeze([] as readonly string[]),
    blockedCidrs: Object.freeze([] as readonly string[]),
  });
}
