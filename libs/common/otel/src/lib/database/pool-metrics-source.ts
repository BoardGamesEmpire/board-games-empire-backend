/**
 * Structural contract a provider exposes so {@link DbPoolMetricsRecorder}
 * can read connection-pool stats from it without `@bge/otel` taking a
 * dependency on `@bge/database`. The recorder discovers providers that
 * satisfy this shape via {@link isDatabasePoolMetricsSource} (duck
 * typing through `DiscoveryService`), mirroring how the BullMQ recorder
 * discovers `Queue` instances.
 *
 * Background (issue #81): Prisma's `metrics` preview feature — and the
 * `prisma.$metrics.json()` API it backed — was removed in Prisma ORM
 * 7.0.0. Connection-pool visibility now comes from the underlying driver
 * adapter's pool. With `@prisma/adapter-pg` that is the `pg` `Pool`,
 * whose `totalCount` / `idleCount` / `waitingCount` getters and
 * `options.max` map onto the fields below.
 */
export interface DatabasePoolMetricsSnapshot {
  /** Total connections currently in the pool (`pg.Pool#totalCount`). */
  readonly open: number;
  /** Connections currently checked out and in use (`total - idle`). */
  readonly busy: number;
  /** Connections currently open but unused (`pg.Pool#idleCount`). */
  readonly idle: number;
  /** Requests queued waiting for a free connection (`pg.Pool#waitingCount`). */
  readonly pending: number;
  /** Configured maximum pool size (`pg.Pool#options.max`). */
  readonly max: number;
}

/**
 * Implemented by a provider (in practice `DatabaseService`) that can
 * surface a synchronous snapshot of its connection pool.
 */
export interface DatabasePoolMetricsSource {
  getDatabasePoolMetrics(): DatabasePoolMetricsSnapshot;
}

/**
 * Type guard used by the recorder to filter discovered DI providers down
 * to those exposing pool metrics. Structural (not `instanceof`) so it
 * survives `DatabaseService`'s `Object.assign(this, this.$extends(...))`
 * mutation, where the CASL extension copies own enumerable properties
 * onto the instance but leaves prototype methods untouched.
 */
export function isDatabasePoolMetricsSource(value: unknown): value is DatabasePoolMetricsSource {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).getDatabasePoolMetrics === 'function'
  );
}
