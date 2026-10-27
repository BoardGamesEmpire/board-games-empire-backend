import {
  Action,
  DatabaseService,
  Event,
  EventStatus,
  isPrismaDependentRecordNotFoundError,
  OccurrenceStatus,
  Prisma,
  ResourceType,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService } from '@bge/permissions';
import { webhookEnvelope, WebhookEventType } from '@bge/webhooks';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import assert from 'node:assert';
import { EventService, eventWebhookIds } from '../event.service';
import { deriveEventStatus, EVENT_STATUS_DATE_SELECT, type EventWithStatus } from '../utils/event-status.util';
import type { CancelEventDto } from './dto/cancel-event.dto';
import {
  EventArchivedEvent,
  EventCancelledEvent,
  EventReopenedEvent,
  EventUnarchivedEvent,
} from './events/event-lifecycle.events';

/** A transition's outcome: the event before and after, and whether this request changed it. */
interface Transition {
  readonly before: Event;
  readonly event: Event;
  readonly changed: boolean;
}

/**
 * Write for a transition, given the event as read under its lock: the event
 * as written, or `null` when the event is already where the request asks it
 * to go.
 */
type TransitionWrite = (tx: Prisma.TransactionClient, existing: Event) => Promise<Event | null>;

/** The statuses an event can be archived from: put away once it is over, one way or the other (#795). */
const ARCHIVABLE: readonly EventStatus[] = [EventStatus.Cancelled, EventStatus.Completed];

/**
 * An event's host decisions: cancel, reopen, archive and unarchive (#795).
 * Each is its own route and its own transition, so a transition's side
 * effects stay with it rather than in a `PATCH`.
 */
@Injectable()
export class EventLifecycleService {
  private readonly logger = new Logger(EventLifecycleService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly eventEmitter: EventEmitter2,
    private readonly abilityService: AbilityService,
    private readonly eventService: EventService,
  ) {}

  /**
   * Calls the event off, with its dates, in one transaction: each Confirmed
   * date becomes Cancelled with the event's reason, canceller and time, and
   * each Proposed date becomes Declined. A date left Confirmed under a
   * cancelled event would make every reader of dates check the event too.
   *
   * The cascade updates dates by status, under the event's row lock. A date
   * confirm that came first is caught by it; one that comes second finds the
   * event cancelled and answers 400. So no date is left Confirmed.
   *
   * One `EventCancelled` domain event goes out, not one per date: one audit
   * row, one webhook, and one notice to each attendee.
   */
  async cancelEvent(id: string, dto: CancelEventDto): Promise<EventWithStatus> {
    const initiatedAt = new Date();
    const userId = this.abilityService.getActingUserId();
    const ceiling = this.cancelCeiling();
    const reason = dto.reason ?? null;

    const { before, event, changed } = await this.transition(id, ceiling, async (tx, existing) => {
      assertNotArchived(existing);

      if (existing.cancelledAt !== null) {
        return null;
      }

      const cancelled = await tx.event.update({
        where: { id, cancelledAt: null, AND: ceiling },
        data: { cancelledAt: initiatedAt, cancelledById: userId, cancelReason: reason },
      });

      await tx.eventOccurrence.updateMany({
        where: { eventId: id, status: OccurrenceStatus.Confirmed },
        data: {
          status: OccurrenceStatus.Cancelled,
          cancelledAt: initiatedAt,
          cancelledById: userId,
          cancelReason: reason,
        },
      });

      await tx.eventOccurrence.updateMany({
        where: { eventId: id, status: OccurrenceStatus.Proposed },
        data: { status: OccurrenceStatus.Declined, declinedAt: initiatedAt },
      });

      return cancelled;
    });

    if (changed) {
      this.eventEmitter.emit(
        EventCancelledEvent.eventName,
        new EventCancelledEvent(cancelSnapshot(before), cancelSnapshot(event), userId, initiatedAt),
      );

      // Keyed on the cancel's time, so an event cancelled again after a
      // reopen is a delivery of its own.
      this.eventEmitter.emit(
        WebhookEventType.EventCancelled,
        webhookEnvelope({
          subjectId: event.id,
          householdId: event.householdId,
          occurrenceId: `${event.id}:cancelled:${initiatedAt.getTime()}`,
          data: eventWebhookIds(event),
        }),
      );
    }

    return this.eventService.statusOf(event);
  }

  /**
   * Undoes a cancel: clears the three cancel columns. The dates stay as the
   * cancel left them, and the host adds or confirms new ones. An archived
   * event is put away, so it is unarchived first.
   */
  async reopenEvent(id: string): Promise<EventWithStatus> {
    const initiatedAt = new Date();
    const userId = this.abilityService.getActingUserId();
    const ceiling = this.cancelCeiling();

    const { before, event, changed } = await this.transition(id, ceiling, async (tx, existing) => {
      assertNotArchived(existing);

      if (existing.cancelledAt === null) {
        return null;
      }

      return tx.event.update({
        where: { id, cancelledAt: { not: null }, archivedAt: null, AND: ceiling },
        data: { cancelledAt: null, cancelledById: null, cancelReason: null },
      });
    });

    if (changed) {
      this.eventEmitter.emit(
        EventReopenedEvent.eventName,
        new EventReopenedEvent(cancelSnapshot(before), cancelSnapshot(event), userId, initiatedAt),
      );

      this.eventEmitter.emit(
        WebhookEventType.EventReopened,
        webhookEnvelope({
          subjectId: event.id,
          householdId: event.householdId,
          occurrenceId: `${event.id}:reopened:${initiatedAt.getTime()}`,
          data: eventWebhookIds(event),
        }),
      );
    }

    return this.eventService.statusOf(event);
  }

  /**
   * Puts a cancelled or finished event away: it leaves `GET /events` unless
   * asked for, and stays readable by id. A live event is cancelled first.
   * Its dates are read under the event's lock, which a date write also
   * takes, so the status judged is the one the write meets. Audited, and
   * nobody is told: no notice and no webhook.
   */
  async archiveEvent(id: string): Promise<EventWithStatus> {
    const initiatedAt = new Date();
    const ceiling = this.archiveCeiling();

    const { before, event, changed } = await this.transition(id, ceiling, async (tx, existing) => {
      if (existing.archivedAt !== null) {
        return null;
      }

      const dates = await tx.eventOccurrence.findMany({ where: { eventId: id }, select: EVENT_STATUS_DATE_SELECT });
      assert(
        ARCHIVABLE.includes(deriveEventStatus(existing, dates, initiatedAt)),
        new BadRequestException(t('errors.event.not_archivable')),
      );

      return tx.event.update({
        where: { id, archivedAt: null, AND: ceiling },
        data: { archivedAt: initiatedAt },
      });
    });

    if (changed) {
      this.eventEmitter.emit(
        EventArchivedEvent.eventName,
        new EventArchivedEvent(archiveSnapshot(before), archiveSnapshot(event), initiatedAt),
      );
    }

    return this.eventService.statusOf(event);
  }

  /**
   * Takes an archived event out again. Its status is what it would be
   * otherwise: Cancelled while it is still cancelled, else from its dates.
   */
  async unarchiveEvent(id: string): Promise<EventWithStatus> {
    const initiatedAt = new Date();
    const ceiling = this.archiveCeiling();

    const { before, event, changed } = await this.transition(id, ceiling, (tx, existing) =>
      existing.archivedAt === null
        ? Promise.resolve(null)
        : tx.event.update({
            where: { id, archivedAt: { not: null }, AND: ceiling },
            data: { archivedAt: null },
          }),
    );

    if (changed) {
      this.eventEmitter.emit(
        EventUnarchivedEvent.eventName,
        new EventUnarchivedEvent(archiveSnapshot(before), archiveSnapshot(event), initiatedAt),
      );
    }

    return this.eventService.statusOf(event);
  }

  /** The caller's ceiling for writing the cancel columns: only the grants bound to `cancelledAt` (#795). */
  private cancelCeiling(): Prisma.EventWhereInput[] {
    // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
    return this.abilityService.getCurrentResourceConditions(ResourceType.Event, Action.update, 'cancelledAt');
  }

  /** The caller's ceiling for writing `archivedAt`: only the grants bound to it (#795). */
  private archiveCeiling(): Prisma.EventWhereInput[] {
    // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
    return this.abilityService.getCurrentResourceConditions(ResourceType.Event, Action.update, 'archivedAt');
  }

  /**
   * Runs one transition under the event's row lock.
   *
   * The lock comes first, `FOR NO KEY UPDATE`, as a write to the event's dates
   * takes it, and the event is read again under it, so the state each branch
   * judges is the state the write meets. A request that loses a race reads
   * the row the winner left and answers as one arriving second would.
   *
   * A transition that finds the event already where it asks to go answers
   * with the event as it is and emits nothing (#252), for a caller whose
   * grant reaches the event. Anyone else gets the 403 the write would have.
   * The write itself requires the state it read, and a write the ceiling
   * refuses finds no row, which answers 403 too.
   */
  private async transition(id: string, ceiling: Prisma.EventWhereInput[], write: TransitionWrite): Promise<Transition> {
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM events WHERE id = ${id} FOR NO KEY UPDATE`);

        const existing = await tx.event.findUnique({ where: { id } });
        assert(existing && existing.deletedAt === null, new NotFoundException(t('errors.event.not_found', { id })));

        const written = await write(tx, existing);
        if (written !== null) {
          return { before: existing, event: written, changed: true };
        }

        const entitled = (await tx.event.count({ where: { id, AND: ceiling } })) > 0;
        assert(entitled, new ForbiddenException(t('common.forbidden.update')));

        return { before: existing, event: existing, changed: false };
      });
    } catch (error) {
      if (isPrismaDependentRecordNotFoundError(error)) {
        this.logger.warn(`Event ${id}: the transition's write found no row the caller may write`);
        throw new ForbiddenException(t('common.forbidden.update'));
      }

      throw error;
    }
  }
}

/** An archived event is put away; only unarchiving it changes it (#795). */
function assertNotArchived(event: Event): void {
  assert(event.archivedAt === null, new BadRequestException(t('errors.event.archived')));
}

/** The archive column. */
function archiveSnapshot(event: Event) {
  return { id: event.id, householdId: event.householdId, archivedAt: event.archivedAt };
}

/** The cancel columns, and what a notice names the event by. */
function cancelSnapshot(event: Event) {
  return {
    id: event.id,
    title: event.title,
    householdId: event.householdId,
    cancelledAt: event.cancelledAt,
    cancelledById: event.cancelledById,
    cancelReason: event.cancelReason,
  };
}
