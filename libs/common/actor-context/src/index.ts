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

// Module (registers reader + internal populator; ClsModule.forRoot is the
// caller's responsibility).
export { AuditContextModule } from './lib/audit-context.module';

// BullMQ envelope helpers + actor-aware worker base.
export { ActorAwareWorkerHost } from './lib/actor-aware.worker-host';
export { JOB_META_KEY, extractJobMeta, wrapJobData, type JobActorMeta, type JobMetaEnvelope } from './lib/job-meta';

// NOTE: `AuditContextInternalService` is intentionally NOT exported from this
// barrel. Interceptors / worker bases that need to populate CLS must import it
// directly via the deep path:
//   import { AuditContextInternalService } from '@bge/actor-context/internal';
// This split enforces "plugins have read-only access to CLS actor; cannot
// forge" (issue #57).
