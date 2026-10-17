import { describeRequiredConfiguration } from '@bge/testing';
import { configModuleOptions } from './configuration';

// docs/DEPLOYMENT.md gives the gateway worker nothing it must set beyond the
// database, which the bootstrap validates.
describeRequiredConfiguration('gateway worker', {
  options: configModuleOptions,
  rootModule: async () => (await import('./gateway-worker.module.js')).GatewayWorkerModule,
  required: {},
  malformed: { REDIS_PORT: 'not a port', REDIS_BULLMQ_PORT: 'not a port' },
});
