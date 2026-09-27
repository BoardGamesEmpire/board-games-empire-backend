import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateEventDto } from './create-event.dto';

/**
 * `householdId` is create-only (#454). Attaching an event to a household is
 * checked once, against the household the create names; moving or detaching
 * one later would need the consent of two households' managers, which no
 * grant a PATCH can check expresses. The global pipe forbids unlisted
 * properties, so a PATCH carrying it answers 400.
 */
export class UpdateEventDto extends PartialType(OmitType(CreateEventDto, ['householdId'] as const)) {}
