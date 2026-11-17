/**
 * What the harness decides about the environment, free of side effects:
 * `global-setup.ts` applies it. As in `apps/api-e2e`, a developer's `.env` is
 * never written. The harness assigns the containers' connection details to
 * `process.env` before Jest starts its workers, and a variable already set in
 * the process wins over `.env`.
 */

/**
 * The images `apps/api-e2e` and `compose.yaml` run. Their tags move by hand,
 * and these move with them.
 */
export const POSTGRES_IMAGE = 'postgres:17-alpine';
export const REDIS_IMAGE = 'redis:7-alpine';

/**
 * The `NODE_ENV` the coordinator child runs under, the value CI runs the
 * suites with. Pinned, because `@bge/env` keys its defaults on it and a
 * developer's shell may hold anything.
 */
export const COORDINATOR_NODE_ENV = 'test';

/**
 * The coordinator's two Redis connections and the logical database each
 * uses, as `apps/gateway-coordinator/src/app/configuration` gives them to
 * `makeRedisConfig`. Pinned so a developer's `.env` can't move one.
 */
const REDIS_DATABASES = { REDIS_: 0, REDIS_BULLMQ_: 2 } as const;

/**
 * Every Redis variable the coordinator reads, pointed at one server. Host,
 * port, credentials and the TLS flag are all set, so a `.env` that names a
 * passworded or TLS server never reaches the container.
 */
export function redisEnvOverrides(host: string, port: number): Record<string, string> {
  const overrides: Record<string, string> = {};

  for (const [prefix, database] of Object.entries(REDIS_DATABASES)) {
    overrides[`${prefix}HOST`] = host;
    overrides[`${prefix}PORT`] = String(port);
    overrides[`${prefix}DATABASE`] = String(database);
    overrides[`${prefix}USERNAME`] = '';
    overrides[`${prefix}PASSWORD`] = '';
    overrides[`${prefix}TLS_ENABLED`] = 'false';
  }

  return overrides;
}
