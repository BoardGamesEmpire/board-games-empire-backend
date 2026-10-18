import { describeRequiredConfiguration } from '@bge/testing';
import { configModuleOptions } from './configuration';

// What docs/DEPLOYMENT.md says the worker needs.
describeRequiredConfiguration('worker', {
  options: configModuleOptions,
  rootModule: async () => (await import('./worker.module.js')).WorkerModule,
  required: {
    production: ['DATA_ENCRYPTION_KEY'],
    staging: ['DATA_ENCRYPTION_KEY', 'MEDIA_LOCAL_DISK_ROOT'],
  },
  // A CACHE_TTL of 0 would keep every entry whose write sets no TTL forever (#537).
  malformed: { REDIS_PORT: 'not a port', REDIS_BULLMQ_PORT: 'not a port', CACHE_TTL: '0' },
});
