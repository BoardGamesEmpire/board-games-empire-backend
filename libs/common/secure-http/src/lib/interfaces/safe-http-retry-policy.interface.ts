/**
 * Per-request retry policy. The service applies retry around the entire
 * request lifecycle including the SSRF gauntlet, so every attempt
 * re-resolves DNS and re-validates the destination. This is deliberate:
 * if the admin policy changes between attempts (e.g. an admin adds the
 * target to `blockedHosts` mid-retry), the next attempt sees the new policy.
 *
 * Callers that don't pass a retry policy get a single attempt and no
 * backoff. BullMQ-driven callers (webhook dispatcher) should typically
 * leave retry undefined and let the queue handle retry — applying retry
 * in both places multiplies attempt counts unintuitively.
 */
export interface SafeHttpRetryPolicy {
  /**
   * Total attempts including the first. `1` is "no retry"; `3` is "one
   * attempt plus two retries". Must be ≥ 1.
   */
  attempts: number;

  /**
   * Initial backoff in milliseconds. Each subsequent attempt waits
   * `baseDelayMs * 2^(attempt-1)`, optionally with jitter, capped at
   * `maxDelayMs`.
   */
  baseDelayMs: number;

  /** Optional cap on backoff. Defaults to `30000` (30s). */
  maxDelayMs?: number;

  /**
   * Apply random jitter (full jitter algorithm: `random(0, computedDelay)`).
   * Defaults to `true` — recommended to avoid thundering-herd retries.
   */
  jitter?: boolean;

  /**
   * Response status codes that trigger a retry. Defaults to `[408, 429, 502, 503, 504]`.
   * Other 4xx/5xx codes are returned to the caller without retry — most
   * application errors are not transient.
   */
  retryOnStatusCodes?: readonly number[];

  /**
   * Whether to retry on network-level failures (connection refused, DNS
   * timeout, socket reset, request timeout). Defaults to `true`.
   *
   * Does NOT apply to SSRF rejections — those are policy failures, not
   * transient network failures, and retry would always reproduce them.
   */
  retryOnNetworkError?: boolean;
}
