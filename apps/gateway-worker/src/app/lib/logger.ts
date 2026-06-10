import { getActorSnapshotFromCls } from '@bge/actor-context';
import { env } from '@bge/env';
import { bootstrapObservability } from '@bge/otel';

export const { otel, bootstrapLogger } = bootstrapObservability({
  serviceName: 'bge-gateway-worker',
  serviceVersion: process.env['npm_package_version'] ?? '0.0.0',
  environment: env.provide('NODE_ENV', { defaultValue: 'development' }),
  actorContextProvider: getActorSnapshotFromCls,
});
