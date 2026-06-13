import { getActorSnapshotFromCls } from '@bge/actor-context';
import { env } from '@bge/env';
import { bootstrapObservability } from '@bge/otel';

const { otel, baseLogger } = bootstrapObservability({
  serviceName: 'bge-api',
  serviceVersion: process.env['npm_package_version'] ?? '0.0.0',
  environment: env.provide('NODE_ENV', { defaultValue: 'development' }),
  actorContextProvider: getActorSnapshotFromCls,
});

/**
 * `component: 'bootstrap'`-tagged child for pre-Nest log lines,
 * shutdown handlers, and the `bootstrap().catch(...)` failure path
 * in `main.ts`. Shares the same transport as `baseLogger` — child
 * loggers do not create new transports — so there is no
 * double-shipping when `pino-opentelemetry-transport` is wired by
 * `buildOtelPinoOptions`.
 */
const bootstrapLogger = baseLogger.child({ component: 'bootstrap' });

export { baseLogger, bootstrapLogger, otel };
