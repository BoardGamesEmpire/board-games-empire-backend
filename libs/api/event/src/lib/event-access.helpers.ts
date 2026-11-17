import { liveEventWhere, type DatabaseService, type Event, type Prisma } from '@bge/database';
import { t } from '@bge/i18n';
import type { AbilityService } from '@bge/permissions';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { NOT_REMOVED } from './constants/not-removed.constant';

/**
 * Whether an event is live: not soft-deleted, and outside any household or in
 * one that is not soft-deleted (`liveEventWhere`, #992). It takes a
 * transaction client too, so a write can ask under the lock it holds.
 */
export async function isEventLive(client: Pick<Prisma.TransactionClient, 'event'>, eventId: string): Promise<boolean> {
  const count = await client.event.count({ where: { id: eventId, ...liveEventWhere() } });

  return count > 0;
}

/**
 * Asserts an event is live ({@link isEventLive}), throwing `NotFoundException`
 * otherwise, the 404 a deleted event gives. Shared by the event sub-resource
 * services (attendee, occurrence, nomination) so the existence predicate lives
 * in exactly one place. A deleted household's events answer the same, for
 * everyone, staff included, until a restore brings them back (#992).
 */
export async function assertEventExists(
  client: Pick<Prisma.TransactionClient, 'event'>,
  eventId: string,
): Promise<void> {
  if (!(await isEventLive(client, eventId))) {
    throw new NotFoundException(t('errors.event.not_found', { id: eventId }));
  }
}

/**
 * The same existence predicate as {@link assertEventExists}, returning the
 * coordinates a create under the event binds to: the event's id and its
 * household. The create paths check the row they are about to write against
 * the ability (`AbilityService.assertCurrentActorCan`), and the household-bound
 * grants need the parent event's `householdId` to match; `null` on an event
 * outside any household, which no household role can reach.
 */
export async function requireEvent(db: DatabaseService, eventId: string): Promise<Pick<Event, 'id' | 'householdId'>> {
  const event = await db.event.findUnique({
    where: { id: eventId, ...liveEventWhere() },
    select: { id: true, householdId: true },
  });

  if (!event) {
    throw new NotFoundException(t('errors.event.not_found', { id: eventId }));
  }

  return event;
}

/**
 * Resolves the acting user's attendee id for an event, throwing
 * `ForbiddenException` when the actor is not an attendee, a host having
 * removed them included (#551). Shared by the nomination and occurrence
 * services, whose mutation paths attribute work to the acting attendee.
 */
export async function resolveActingAttendeeId(
  db: DatabaseService,
  abilityService: AbilityService,
  eventId: string,
): Promise<string> {
  const userId = abilityService.getActingUserId();
  const attendee = await db.eventAttendee.findUnique({
    where: { eventId_userId: { eventId, userId }, ...NOT_REMOVED },
    select: { id: true },
  });

  if (!attendee) {
    throw new ForbiddenException(t('errors.event.not_attendee'));
  }

  return attendee.id;
}
