import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, ArrayUnique, IsIn, IsOptional, IsString, IsUrl, MinLength } from 'class-validator';
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from '../constants/webhook-event-types';

/**
 * Mutable subset of a subscription. `resourceType`/`resourceId`/`householdId`
 * are immutable after create — changing the scope would silently change the
 * audience of an existing standing grant, so a re-scope is a new subscription.
 *
 * Status is not freely settable here: re-enabling a Failed/Disabled
 * subscription goes through the service's `reactivate` path (which resets the
 * failure counter and re-checks the creator's grant), not a raw status write.
 */
export class UpdateWebhookSubscriptionDto {
  @ApiPropertyOptional({
    description:
      'Endpoint that will receive signed deliveries. HTTPS for public endpoints; plaintext HTTP ' +
      'is permitted for internal-only, in-cluster targets where transport is already isolated.',
  })
  @IsOptional()
  // See CreateWebhookSubscriptionDto.url — `http` is intentionally allowed for internal targets.
  @IsUrl({ require_protocol: true, protocols: ['https', 'http'] })
  url?: string;

  @ApiPropertyOptional({ isArray: true, enum: WEBHOOK_EVENT_TYPES })
  @IsOptional()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsIn(WEBHOOK_EVENT_TYPES, { each: true })
  eventTypes?: WebhookEventType[];

  @ApiPropertyOptional({ description: 'Rotate the signing secret (minimum 16 characters).' })
  @IsOptional()
  @IsString()
  @MinLength(16)
  secret?: string;
}
