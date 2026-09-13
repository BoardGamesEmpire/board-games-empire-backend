import type { DatabaseService, Event } from '@bge/database';
import { t } from '@bge/i18n';
import type { AbilityService } from '@bge/permissions';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

/**
 * Asserts an event exists (and is not soft-deleted), throwing `NotFoundException`
 * otherwise. Shared by the event sub-resource services (attendee, occurrence,
 * nomination) so the existence predicate lives in exactly one place.
 */
export async function assertEventExists(db: DatabaseService, eventId: string): Promise<void> {
  const count = await db.event.count({
    where: { id: eventId, deletedAt: null },
  });

  if (count === 0) {
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
    where: { id: eventId, deletedAt: null },
    select: { id: true, householdId: true },
  });

  if (!event) {
    throw new NotFoundException(t('errors.event.not_found', { id: eventId }));
  }

  return event;
}

/**
 * Resolves the acting user's attendee id for an event, throwing
 * `ForbiddenException` when the actor is not an attendee. Shared by the
 * nomination and occurrence services, whose mutation paths attribute work to
 * the acting attendee.
 */
export async function resolveActingAttendeeId(
  db: DatabaseService,
  abilityService: AbilityService,
  eventId: string,
): Promise<string> {
  const userId = abilityService.getActingUserId();
  const attendee = await db.eventAttendee.findUnique({
    where: { eventId_userId: { eventId, userId } },
    select: { id: true },
  });

  if (!attendee) {
    throw new ForbiddenException(t('errors.event.not_attendee'));
  }

  return attendee.id;
}
