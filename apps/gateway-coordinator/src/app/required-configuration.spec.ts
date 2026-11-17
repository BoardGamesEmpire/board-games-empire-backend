import { describeRequiredConfiguration } from '@bge/testing';
import { configModuleOptions } from './configuration';

// docs/DEPLOYMENT.md gives the coordinator nothing it must set beyond the
// database, which the bootstrap validates. Its plugins root, PLUGINS_ROOT,
// defaults as the api's does (#1083); any path passes validation, so it has
// no malformed value here.
describeRequiredConfiguration('coordinator', {
  options: configModuleOptions,
  rootModule: async () => (await import('./app.module.js')).AppModule,
  required: {},
  malformed: { REDIS_PORT: 'not a port', REDIS_BULLMQ_PORT: 'not a port' },
});
