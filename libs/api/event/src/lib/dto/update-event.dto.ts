import { EventSchedulingMode, EventType } from '@bge/database';
import { OmitType, PartialType } from '@nestjs/swagger';
import type { EventReach } from './create-event.dto';
import { CreateEventDto, EventEnumProperty, EventReachProperty, EventTitleProperty } from './create-event.dto';

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
 *
 * `policy`, `occurrences` and `inviteUserIds` each have a route of their own
 * (#796): the policy under its own grant, dates under the occurrence routes
 * and their lock, invites under the invite routes. Honouring them here would
 * be a second, weaker way to do each, so a PATCH carrying one answers 400.
 *
 * `title`, `type` and `schedulingMode` can't be cleared, so they are
 * redeclared with `ValidateIf` rather than `PartialType`'s `IsOptional`, which
 * skips `null` too: `null` answers 400 instead of reaching a non-nullable
 * column as a 500 (#1404). None names a default, so a PATCH that leaves one
 * out keeps the stored value. `description`, `image`, `location` and `url`
 * keep `null`, which clears them.
 */
export class UpdateEventDto extends PartialType(
  OmitType(CreateEventDto, [
    'householdId',
    'title',
    'type',
    'reach',
    'schedulingMode',
    'clientRequestId',
    'policy',
    'occurrences',
    'inviteUserIds',
  ] as const),
) {
  @EventTitleProperty({ optional: true })
  title?: string;

  @EventEnumProperty(EventType)
  type?: EventType;

  @EventReachProperty()
  reach?: EventReach;

  @EventEnumProperty(EventSchedulingMode)
  schedulingMode?: EventSchedulingMode;
}
