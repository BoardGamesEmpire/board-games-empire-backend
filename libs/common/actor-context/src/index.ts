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

export { AuditExclude, Auditable, MutationEvent, type MutationAction } from './lib/decorators/mutation-event';

// Public CLS reader (DI-injected).
export { AuditContextService } from './lib/services/audit-context.service';

// Public CLS reader (static, non-DI). For consumers that cannot receive
// DI — most notably the `ActorSpanProcessor` in `@bge/otel`, which is
// constructed at OTel SDK init before any provider exists. Application
// code, plugins, and listeners should continue to use `AuditContextService`.
export { getActorSnapshotFromCls, type ActorContextSnapshot } from './lib/services/get-actor-snapshot-from-cls';

// Sanctioned scope opener for system-initiated work (pings, scheduled tasks,
// bootstrap discovery). Mints `system` actors with a caller-supplied reason.
// Public — inject from anywhere. Cannot be used to forge user / apiKey /
// other actor variants.
export { SystemActorScope } from './lib/services/system-actor-scope.service';

// Internal CLS populator + raw CLS keys. Exported here so the bundler inlines
// them, but RESTRICTED via ESLint `no-restricted-imports` (see the repo root
// eslint.config.mjs) to entry-point interceptors and worker bases only.
// Application code and plugins MUST use the read-only AuditContextService —
// this enforces "plugins have read-only access to CLS actor; cannot forge"
// (issue #57). System code paths use SystemActorScope instead.
export { AuditContextInternalService, type ActorContextInit } from './lib/services/audit-context-internal.service';
export { ACTOR_CLS_KEY, CORRELATION_ID_CLS_KEY, SOURCE_CLS_KEY } from './lib/services/audit-context.service';

// Module (registers reader + internal populator + system scope; ClsModule.forRoot
// is the caller's responsibility).
export { AuditContextModule } from './lib/audit-context.module';
