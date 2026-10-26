import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateEventDto, EventReachProperty, type EventReach } from './create-event.dto';

/**
 * `householdId` is create-only (#454). Attaching an event to a household is
 * checked once, against the household the create names; moving or detaching
 * one later would need the consent of two households' managers, which no
 * grant a PATCH can check expresses. The global pipe forbids unlisted
 * properties, so a PATCH carrying it answers 400.
 *
 * `clientRequestId` is the create's own key (#252): an edit that rewrote it
 * would strand a retried create into a second event, and one that copied
 * another of the creator's keys would trip the unique (#534). Omitted the same
 * way, so a PATCH carrying it answers 400 too.
 */
export class UpdateEventDto extends PartialType(
  OmitType(CreateEventDto, ['householdId', 'reach', 'clientRequestId'] as const),
) {
  @EventReachProperty()
  reach?: EventReach;
}
