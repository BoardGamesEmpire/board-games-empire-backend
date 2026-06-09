export {
  actorUserId,
  isAnonymousActor,
  isApiKeyActor,
  isExternalActor,
  isPluginActor,
  isSystemActor,
  isUserActor,
  resolveTrigger,
} from './lib/types';

export type {
  Actor,
  ActorKind,
  AnonymousActor,
  ApiKeyActor,
  EventMeta,
  EventSource,
  ExternalActor,
  PluginActor,
  SystemActor,
  UserActor,
} from './lib/types';

export { AuditExclude, Auditable, MutationEvent } from './lib/decorators/mutation-event';

// Public CLS reader.
export { AuditContextService } from './lib/services/audit-context.service';

// Internal CLS populator + raw CLS keys. Exported here so the bundler inlines
// them, but RESTRICTED via ESLint `no-restricted-imports` (see the repo root
// eslint.config.mjs) to entry-point interceptors and worker bases only.
// Application code and plugins MUST use the read-only AuditContextService —
// this enforces "plugins have read-only access to CLS actor; cannot forge"
// (issue #57).
export { AuditContextInternalService, type ActorContextInit } from './lib/services/audit-context-internal.service';
export { ACTOR_CLS_KEY, CORRELATION_ID_CLS_KEY, SOURCE_CLS_KEY } from './lib/services/audit-context.service';

// Module (registers reader + internal populator; ClsModule.forRoot is the
// caller's responsibility).
export { AuditContextModule } from './lib/audit-context.module';

// BullMQ envelope helpers + actor-aware worker base.
export { ActorAwareWorkerHost } from './lib/actor-aware.worker-host';
export { JOB_META_KEY, extractJobMeta, wrapJobData, type JobActorMeta, type JobMetaEnvelope } from './lib/job-meta';
