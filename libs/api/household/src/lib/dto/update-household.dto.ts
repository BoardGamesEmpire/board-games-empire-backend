import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateHouseholdDto } from './create-household.dto';

/**
 * Everything a create sets, less the create's own idempotency key.
 * `clientRequestId` is how a retried create finds the row it already made
 * (#210), so an edit that rewrote it would strand that retry into a second
 * household, and one that copied another of the creator's keys would trip the
 * `(createdById, clientRequestId)` unique (#534). Omitted rather than
 * ignored: under the global `forbidNonWhitelisted` pipe a PATCH carrying it
 * answers 400, and the published schema no longer offers it.
 */
export class UpdateHouseholdDto extends PartialType(OmitType(CreateHouseholdDto, ['clientRequestId'] as const)) {}
