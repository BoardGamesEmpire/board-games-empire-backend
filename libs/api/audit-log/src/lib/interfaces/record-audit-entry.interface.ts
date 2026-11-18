import type { Actor, EventSource } from '@bge/actor-context';

/**
 * Fully-resolved audit row input, assembled by the persistence listener:
 * event identity from the emitter, actor/source/correlationId from CLS (or
 * the unattributed fallback), snapshots already redacted per @AuditExclude.
 */
export interface RecordAuditEntry {
  /** MutationAction today; plugin-specific verbs may widen this later. */
  readonly action: string;

  readonly actor: Actor;
  readonly after: Record<string, unknown> | null;
  readonly before: Record<string, unknown> | null;
  readonly correlationId: string | null;
  readonly event: string;
  readonly initiatedAt: Date;
  readonly occurredAt: Date;
  readonly source: EventSource | null;
  readonly subject: string;
  readonly subjectId: string;
}
