import { ResourceType } from '@bge/database';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, ArrayUnique, IsEnum, IsIn, IsOptional, IsString, IsUrl, MinLength } from 'class-validator';
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from '../constants/webhook-event-types';

export class CreateWebhookSubscriptionDto {
  @ApiProperty({
    description:
      'Endpoint that will receive signed deliveries. HTTPS is expected for public endpoints; ' +
      'plaintext HTTP is intentionally permitted for in-cluster, internal-only targets ' +
      '(e.g. a Kubernetes service address) where transport is already isolated.',
  })
  // `http` is allowed on purpose — do not drop it. Public receivers should use
  // HTTPS, but service-to-service delivery to internal addresses (cluster DNS,
  // sidecars) runs over the trusted internal network and may be plaintext.
  @IsUrl({ require_protocol: true, protocols: ['https', 'http'] })
  url!: string;

  @ApiProperty({ enum: ResourceType, description: 'Subject the subscription is about.' })
  @IsEnum(ResourceType)
  resourceType!: ResourceType;

  @ApiProperty({
    isArray: true,
    enum: WEBHOOK_EVENT_TYPES,
    description: 'Versioned event names; each must map to resourceType in the registry.',
  })
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsIn(WEBHOOK_EVENT_TYPES, { each: true })
  eventTypes!: WebhookEventType[];

  @ApiPropertyOptional({ description: 'Narrow to a specific instance of resourceType.' })
  @IsOptional()
  @IsString()
  resourceId?: string;

  @ApiPropertyOptional({ description: 'Narrow to a household container the creator can read.' })
  @IsOptional()
  @IsString()
  householdId?: string;

  @ApiPropertyOptional({ description: 'Signing secret. Generated server-side when omitted.' })
  @IsOptional()
  @IsString()
  @MinLength(16)
  secret?: string;
}
