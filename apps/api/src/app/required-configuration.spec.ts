import { describeRequiredConfiguration } from '@bge/testing';
import { configModuleOptions } from './configuration';

// What docs/DEPLOYMENT.md says the api needs.
describeRequiredConfiguration('api', {
  options: configModuleOptions,
  rootModule: async () => (await import('./app.module.js')).AppModule,
  required: {
    production: ['BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'DATA_ENCRYPTION_KEY'],
    staging: ['BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'DATA_ENCRYPTION_KEY', 'MEDIA_LOCAL_DISK_ROOT'],
  },
  malformed: { REDIS_PORT: 'not a port', REDIS_BULLMQ_PORT: 'not a port' },
});
