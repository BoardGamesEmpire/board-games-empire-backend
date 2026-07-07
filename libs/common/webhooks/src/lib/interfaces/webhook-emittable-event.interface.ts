/**
 * Contract every webhook-eligible domain event implements. The taxonomy
 * migration (companion to #57) reshapes the relevant emit sites to carry this
 * alongside the `MutationEvent` audit envelope.
 *
 * The dispatcher reads routing/authorization inputs from the *event instance*
 * (here), and static metadata (subject type, required grant) from the
 * `WebhookEventRegistry`. Keeping the two apart means descriptors need no
 * payload generics and the dispatcher needs no `any`: it narrows an arbitrary
 * emitted value with `isWebhookEmittableEvent` once, then everything is typed.
 *
 * - `subjectId`    primary key of the subject record the event concerns; used
 *                  for the CASL `accessibleBy` existence check at dispatch and
 *                  for `resourceId`-scoped subscription matching.
 * - `householdId`  resolved container, or `null` when the subject is not
 *                  household-scoped (e.g. a venue-based Event). Drives
 *                  `householdId`-scoped subscription matching.
 * - `data`         PII-safe, receiver-facing body. This is what gets signed and
 *                  POSTed; emit sites are responsible for excluding anything a
 *                  read-authorized subscriber should not see.
 * - `occurrenceId` optional STABLE identifier of this event occurrence (e.g. the
 *                  audit/mutation row id), identical across re-emits of the same
 *                  logical event. When present, the dispatcher derives a
 *                  deterministic queue jobId from it so a duplicate emit dedups
 *                  to a single delivery; when absent, each dispatch is treated as
 *                  unique (no dedup). It must be stable to be useful — a value
 *                  freshly generated per emit provides no idempotency.
 *
 * Actor, source, and correlationId are deliberately NOT here — they live in
 * CLS (see MutationEvent) and the dispatcher captures them at enqueue.
 */
export interface WebhookEmittableEvent<TData = unknown> {
  readonly subjectId: string;
  readonly householdId: string | null;
  readonly data: TData;
  readonly occurrenceId?: string;
}

/**
 * Builds the envelope every webhook-eligible emit site must carry. Prefer this
 * over a hand-written object literal: it centralizes the contract (notably
 * that `occurrenceId` should be a STABLE id so duplicate emits dedup to one
 * delivery, and that `householdId` defaults to null for non-household-scoped
 * subjects) instead of enforcing it by copy-paste.
 */
export function webhookEnvelope<TData>(args: {
  subjectId: string;
  data: TData;
  /** Stable id of this logical event occurrence — enables delivery dedup. */
  occurrenceId?: string;
  householdId?: string | null;
}): WebhookEmittableEvent<TData> {
  return {
    subjectId: args.subjectId,
    householdId: args.householdId ?? null,
    occurrenceId: args.occurrenceId,
    data: args.data,
  };
}

/**
 * Narrows an arbitrary EventEmitter2 payload to the contract. Structural, not
 * nominal — any event carrying the three fields qualifies, which is what lets
 * the dispatcher subscribe with `onAny` and filter by the registry rather than
 * by class identity.
 */
export function isWebhookEmittableEvent(value: unknown): value is WebhookEmittableEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['subjectId'] === 'string' &&
    (typeof candidate['householdId'] === 'string' || candidate['householdId'] === null) &&
    'data' in candidate
  );
}
