import { ResourceType } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
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
  @IsUrl(
    { require_protocol: true, protocols: ['https', 'http'] },
    { message: i18nValidationMessage('validation.isUrl') },
  )
  url!: string;

  @ApiProperty({ enum: ResourceType, description: 'Subject the subscription is about.' })
  @IsEnum(ResourceType, { message: i18nValidationMessage('validation.isEnum') })
  resourceType!: ResourceType;

  @ApiProperty({
    isArray: true,
    enum: WEBHOOK_EVENT_TYPES,
    description: 'Versioned event names; each must map to resourceType in the registry.',
  })
  @ArrayNotEmpty({ message: i18nValidationMessage('validation.arrayNotEmpty') })
  @ArrayUnique({ message: i18nValidationMessage('validation.arrayUnique') })
  @IsIn(WEBHOOK_EVENT_TYPES, { each: true, message: i18nValidationMessage('validation.each.isIn') })
  eventTypes!: WebhookEventType[];

  @ApiPropertyOptional({ description: 'Narrow to a specific instance of resourceType.' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  resourceId?: string;

  @ApiPropertyOptional({ description: 'Narrow to a household container the creator can read.' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  householdId?: string;

  @ApiPropertyOptional({ description: 'Signing secret. Generated server-side when omitted.' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MinLength(16, { message: i18nValidationMessage('validation.minLength') })
  secret?: string;
}
