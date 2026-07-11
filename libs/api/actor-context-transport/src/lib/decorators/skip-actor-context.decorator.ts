import { SetMetadata } from '@nestjs/common';

/** Metadata key marking a handler as exempt from actor-context enforcement. */
export const SKIP_ACTOR_CONTEXT_KEY = 'skip-actor-context';

/**
 * Marks a gRPC handler (or a whole controller) as exempt from the
 * `GrpcInternalActorInterceptor`'s `x-bge-actor` requirement.
 *
 * Use on unauthenticated infra endpoints that legitimately arrive with no
 * actor — chiefly the gRPC health `Check` RPC, which liveness/readiness probes
 * (k8s, load balancers, grpc_health_probe) call without any actor metadata.
 * Without this exemption the globally-registered interceptor rejects the probe
 * with UNAUTHENTICATED and the health check is unusable by infrastructure.
 *
 * Do NOT use to bypass actor context on business RPCs: those travel a trusted
 * internal channel where a missing actor is a caller-side bug that must fail
 * loudly per the pre-alpha policy.
 */
export const SkipActorContext = () => SetMetadata(SKIP_ACTOR_CONTEXT_KEY, true);
