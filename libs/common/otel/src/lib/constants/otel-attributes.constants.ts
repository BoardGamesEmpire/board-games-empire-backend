/**
 * BGE-specific OpenTelemetry semantic attribute keys.
 *
 * Namespaced under `bge.*` to avoid collision with upstream OTel semantic
 * conventions. Stamped on every span via {@link ActorSpanProcessor} reading
 * the current audit context snapshot supplied by the host application.
 *
 * PII policy: this catalogue intentionally OMITS user identifiers,
 * API key identifiers, plugin trigger user IDs, and external system
 * identifiers (which can be email-like). The `Actor` discriminated union
 * exposes those fields publicly because they are required for audit log
 * persistence (#57 Phase 2), but spans are replicated too widely to be a
 * safe PII carrier. Incident reconstruction joins on `correlationId` and
 * pulls the actor identity from the audit log.
 *
 * The keys here are the COMPLETE allow-list. Adding a new BGE span
 * attribute requires evaluating its PII status against this same policy.
 */
export const BGE_OTEL_ATTRIBUTES = {
  /**
   * Actor variant tag — `user` | `anonymous` | `apiKey` | `system` | `plugin` | `external`.
   */
  ACTOR_KIND: 'bge.actor.kind',

  /**
   * Plugin identifier — only set when `actor.kind === 'plugin'`. Plugin IDs are not PII.
   */
  ACTOR_PLUGIN_ID: 'bge.actor.plugin_id',

  /**
   * Kind of actor that triggered a plugin actor — only set when
   * `actor.kind === 'plugin'`, derived from `actor.trigger.kind`. Useful
   * for distinguishing plugin-on-behalf-of-user from plugin-on-behalf-of-scheduler
   * without exposing the trigger's identity.
   */
  ACTOR_TRIGGER_KIND: 'bge.actor.trigger_kind',

  /**
   * Consent-unit scope a plugin actor operated as (`Server` | `Household` |
   * `User`) — only set when `actor.kind === 'plugin'` (#60). The one
   * coordinate that decided the plugin's authority for the span.
   */
  ACTOR_PLUGIN_UNIT_SCOPE: 'bge.actor.plugin_unit_scope',

  /**
   * The unit's coordinate id (Household.id / User.id) — only set for
   * household/user units. Same PII posture as `HOUSEHOLD_ID`: an opaque
   * row id, not an identity attribute.
   */
  ACTOR_PLUGIN_UNIT_ID: 'bge.actor.plugin_unit_id',

  /**
   * External system label — only set when `actor.kind === 'external'`.
   * The system tag (e.g. `'gateway'`) is not PII; the identifier within
   * the system IS withheld.
   */
  ACTOR_EXTERNAL_SYSTEM: 'bge.actor.external_system',

  /**
   * Household scope, when the operation is bounded to a single household.
   */
  HOUSEHOLD_ID: 'bge.household.id',

  /**
   * Cross-protocol correlation identifier. Distinct from the OTel trace
   * ID — correlation IDs are human-readable, propagated via
   * `x-correlation-id`, and emitted in logs/audit. Trace IDs ride
   * `traceparent` and span the OTel surface only.
   */
  CORRELATION_ID: 'bge.correlation_id',
} as const;

export type BgeOtelAttributeKey = (typeof BGE_OTEL_ATTRIBUTES)[keyof typeof BGE_OTEL_ATTRIBUTES];
