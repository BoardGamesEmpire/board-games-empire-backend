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
import { eventWebhookIds } from '../event.service';
import {
  deriveEventStatus,
  EVENT_STATUS_DATE_SELECT,
  withEventStatus,
  type EventStatusDate,
  type EventWithStatus,
} from '../utils/event-status.util';
import type { CancelEventDto } from './dto/cancel-event.dto';
import {
  EventArchivedEvent,
  EventCancelledEvent,
  EventReopenedEvent,
  EventUnarchivedEvent,
} from './events/event-lifecycle.events';

/**
 * A transition's outcome: the event before and after, whether this request
 * changed it, and the event as served, with its status.
 */
interface Transition {
  readonly before: Event;
  readonly event: Event;
  readonly changed: boolean;
  readonly served: EventWithStatus;
}

/**
 * Write for a transition, given the event and its dates as read under its
 * lock: the event as written, or `null` when the event is already where the
 * request asks it to go.
 */
type TransitionWrite = (
  tx: Prisma.TransactionClient,
  existing: Event,
  dates: readonly EventStatusDate[],
) => Promise<Event | null>;

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
   * row, one webhook, and one notification to each attendee.
   */
  async cancelEvent(id: string, dto: CancelEventDto): Promise<EventWithStatus> {
    const initiatedAt = new Date();
    const userId = this.abilityService.getActingUserId();
    const ceiling = this.cancelCeiling();
    const reason = dto.reason ?? null;

    const { before, event, changed, served } = await this.transition(id, ceiling, async (tx, existing) => {
      // Already cancelled, archived since or not: the event is where the
      // cancel asks it to go, so a retry answers with it.
      if (existing.cancelledAt !== null) {
        return null;
      }

      assertNotArchived(existing);

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

    return served;
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

    const { before, event, changed, served } = await this.transition(id, ceiling, async (tx, existing) => {
      // Not cancelled, archived since or not: the event is where the reopen
      // asks it to go, so a retry answers with it, as a cancel's does.
      if (existing.cancelledAt === null) {
        return null;
      }

      assertNotArchived(existing);

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

    return served;
  }

  /**
   * Puts a cancelled or finished event away: it leaves `GET /events` unless
   * asked for, and stays readable by id. A live event is cancelled first.
   * The status judged is from the dates {@link transition} reads under the
   * event's lock, which a date write also takes, so it is the one the write
   * meets. Audited, and nobody is told: no notification and no webhook.
   */
  async archiveEvent(id: string): Promise<EventWithStatus> {
    const initiatedAt = new Date();
    const ceiling = this.archiveCeiling();

    const { before, event, changed, served } = await this.transition(id, ceiling, async (tx, existing, dates) => {
      if (existing.archivedAt !== null) {
        return null;
      }

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

    return served;
  }

  /**
   * Takes an archived event out again. Its status is what it would be
   * otherwise: Cancelled while it is still cancelled, else from its dates.
   */
  async unarchiveEvent(id: string): Promise<EventWithStatus> {
    const initiatedAt = new Date();
    const ceiling = this.archiveCeiling();

    const { before, event, changed, served } = await this.transition(id, ceiling, (tx, existing) =>
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

    return served;
  }

  /** The actor's ceiling for writing the cancel columns: only the grants bound to `cancelledAt` (#795). */
  private cancelCeiling(): Prisma.EventWhereInput[] {
    // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
    return this.abilityService.getCurrentResourceConditions(ResourceType.Event, Action.update, 'cancelledAt');
  }

  /** The actor's ceiling for writing `archivedAt`: only the grants bound to it (#795). */
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
   * The actor's grant is checked next, against the row, before the event's
   * state is judged: someone the grant doesn't reach gets 403, never a 400
   * that would tell them whether the event is cancelled, archived or over.
   *
   * A transition that finds the event already where it asks to go answers
   * with the event as it is and emits nothing (#252). The write itself
   * requires the state it read and is bound to the same grant, so a write
   * that finds no row answers 403 too.
   *
   * The event's dates are read under the lock too, before the write, and the
   * answer's status is worked out from them, so nothing is read after the
   * commit: a read that failed there would report a transition that happened
   * as one that didn't. No transition changes a date the status counts but
   * cancel, and a cancelled event reads Cancelled whatever its dates.
   */
  private async transition(id: string, ceiling: Prisma.EventWhereInput[], write: TransitionWrite): Promise<Transition> {
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM events WHERE id = ${id} FOR NO KEY UPDATE`);

        const existing = await tx.event.findUnique({ where: { id } });
        assert(existing && existing.deletedAt === null, new NotFoundException(t('errors.event.not_found', { id })));

        const entitled = (await tx.event.count({ where: { id, AND: ceiling } })) > 0;
        assert(entitled, new ForbiddenException(t('common.forbidden.update')));

        const dates = await tx.eventOccurrence.findMany({ where: { eventId: id }, select: EVENT_STATUS_DATE_SELECT });
        const written = await write(tx, existing, dates);
        const event = written ?? existing;

        return {
          before: existing,
          event,
          changed: written !== null,
          served: withEventStatus(event, dates, new Date()),
        };
      });
    } catch (error) {
      if (isPrismaDependentRecordNotFoundError(error)) {
        this.logger.warn(`Event ${id}: the transition's write found no row the actor may write`);
        throw new ForbiddenException(t('common.forbidden.update'));
      }

      throw error;
    }
  }
}

/**
 * Refuses a cancel or reopen of an archived event: unarchive it first (#795).
 * Other writes to an archived event are #956's.
 */
function assertNotArchived(event: Event): void {
  assert(event.archivedAt === null, new BadRequestException(t('errors.event.archived')));
}

/** The archive column. */
function archiveSnapshot(event: Event) {
  return { id: event.id, householdId: event.householdId, archivedAt: event.archivedAt };
}

/** The cancel columns, and what a notification names the event by. */
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
