// Deep import path: `@bge/actor-context/internal`.
//
// Reserved for entry-point interceptors (HTTP, gRPC) and worker bases that
// need to populate CLS with the actor + correlation context. Application code
// and plugins MUST NOT import from this path — use AuditContextService from
// the main barrel instead.
export { AuditContextInternalService, type ActorContextInit } from './lib/services/audit-context-internal.service';

export { ACTOR_CLS_KEY, CORRELATION_ID_CLS_KEY, SOURCE_CLS_KEY } from './lib/services/audit-context.service';
