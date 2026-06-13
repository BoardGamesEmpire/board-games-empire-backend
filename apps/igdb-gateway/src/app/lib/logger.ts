import { bootstrapLogging } from '@bge/logger';

const baseLogger = bootstrapLogging({ serviceName: 'bge-gateway-igdb' });
const bootstrapLogger = baseLogger.child({ component: 'bootstrap' });

export { baseLogger, bootstrapLogger };
