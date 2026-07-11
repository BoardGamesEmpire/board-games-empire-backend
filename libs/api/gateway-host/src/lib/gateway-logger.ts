import { bootstrapLogging } from '@bge/logger';

type GatewayLogger = ReturnType<typeof bootstrapLogging>;

export interface GatewayLoggers {
  /**
   * Root pino logger bound with the `service` attribute. Feed straight to
   * `LoggerModule.forRoot({ pinoHttp: { logger } })`.
   */
  readonly baseLogger: GatewayLogger;

  /**
   * `component: 'bootstrap'`-tagged child for pre-Nest log lines, shutdown
   * handlers, and the bootstrap-failure path in `main.ts`. Shares the same
   * transport as `baseLogger`.
   */
  readonly bootstrapLogger: GatewayLogger;
}

/**
 * Builds the base + bootstrap loggers every gateway microservice host
 * needs. Replaces the per-app `lib/logger.ts` that differed only in the
 * `serviceName` string.
 *
 * @param serviceName Logical service identifier, e.g. `'bge-gateway-bgg'`.
 */
export function createGatewayLogger(serviceName: string): GatewayLoggers {
  const baseLogger = bootstrapLogging({ serviceName });
  const bootstrapLogger = baseLogger.child({ component: 'bootstrap' });

  return { baseLogger, bootstrapLogger };
}
