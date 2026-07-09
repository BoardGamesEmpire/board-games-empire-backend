import type { Actor, EventSource } from '@bge/actor-context';

/**
 * Fully-resolved audit row input, assembled by the persistence listener:
 * event identity from the emitter, actor/source/correlationId from CLS (or
 * the unattributed fallback), snapshots already redacted per @AuditExclude.
 */
export interface RecordAuditEntry {
  readonly event: string;
  readonly actor: Actor;
  /** MutationAction today; plugin-specific verbs may widen this later. */
  readonly action: string;
  readonly subject: string;
  readonly subjectId: string;
  readonly source: EventSource | null;
  readonly correlationId: string | null;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly initiatedAt: Date;
  readonly occurredAt: Date;
}
