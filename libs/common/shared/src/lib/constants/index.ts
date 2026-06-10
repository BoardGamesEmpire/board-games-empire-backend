// BetterAuth does not export this, but we need it for our custom PoliciesGuard
export const IS_PUBLIC_KEY = 'PUBLIC';
export const IS_OPTIONAL_KEY = 'OPTIONAL';

export const TRACEPARENT_HEADER = 'traceparent' as const;
export const CORRELATION_ID_HEADER = 'x-correlation-id' as const;

/**
 * Metadata key carrying the serialized {@link Actor} between BGE services
 * over gRPC. Set by the outbound actor-metadata interceptor on the
 * caller side, consumed by the trusted-internal inbound interceptor on
 * the receiver side. Value is base64-encoded UTF-8 JSON.
 *
 * Trust model: the gRPC channel itself is the boundary (mTLS / network
 * policy in production, loopback in dev). No signing or HMAC at this
 * layer — receivers structurally validate but do not authenticate the
 * payload cryptographically.
 *
 * This metadata is NOT propagated to OTel spans. PII filtering for
 * spans happens in `@bge/otel`'s `ActorSpanProcessor`; the actor
 * carried here remains the source of truth for audit log entries on
 * the receiver side.
 */
export const BGE_ACTOR_HEADER = 'x-bge-actor' as const;
