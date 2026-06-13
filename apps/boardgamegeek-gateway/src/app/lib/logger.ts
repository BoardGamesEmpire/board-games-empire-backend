import { bootstrapLogging } from '@bge/logger';

const baseLogger = bootstrapLogging({ serviceName: 'bge-gateway-bgg' });

/**
 * `component: 'bootstrap'`-tagged child for pre-Nest log lines,
 * shutdown handlers, and the `bootstrap().catch(...)` failure path
 * in `main.ts`. Shares the same transport as `baseLogger`.
 */
const bootstrapLogger = baseLogger.child({ component: 'bootstrap' });

export { baseLogger, bootstrapLogger };
