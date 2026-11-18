import { PluginGrantStatus, type PluginGrant } from '@bge/database';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { grantSnapshot } from '../events/plugin-event-snapshots';
import {
  PluginGrantCreatedEvent,
  PluginGrantRejectedEvent,
  type PluginGrantEventContext,
} from '../events/plugin.events';

/** A consent decision a consent act wrote, with the row it replaced. */
export interface WrittenDecision {
  readonly after: PluginGrant;
  readonly before: PluginGrant | null;
}

/**
 * One event per consent decision whose row a consent act changed, each
 * carrying the act, so every lifecycle row the act leaves names it (#1150,
 * #1336). A grant announces a creation and a refusal a rejection. Shared by the
 * household and user act and the server act so the two cannot disagree on
 * which event a decision announces. Runs after the commit and takes no lock.
 */
export function emitDecisionEvents(
  emitter: EventEmitter2,
  changedDecisions: readonly WrittenDecision[],
  context: PluginGrantEventContext,
  initiatedAt: Date,
): void {
  for (const { before, after } of changedDecisions) {
    const EventClass = after.status === PluginGrantStatus.Granted ? PluginGrantCreatedEvent : PluginGrantRejectedEvent;

    emitter.emit(
      EventClass.eventName,
      new EventClass(before === null ? null : grantSnapshot(before), grantSnapshot(after), context, initiatedAt),
    );
  }
}
