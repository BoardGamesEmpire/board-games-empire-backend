import type { DatabaseService } from '@bge/database';
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
