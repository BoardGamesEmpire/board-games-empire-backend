import { PluginGrantStatus } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString } from 'class-validator';

/**
 * One consent decision (#322): which requested permission, and the
 * polarity. Shape-only validation — whether the slug is decidable at all
 * (requested by the manifest, right consent scope, not categorically
 * excluded, not a required-denial contradiction) is the service's call, and
 * every refusal comes back as its typed domain error through the filter.
 * The decider is NEVER part of the body: identity comes from CLS at the
 * edge (D-AZ).
 */
export class DecidePluginGrantDto {
  @ApiProperty({
    description:
      "CANONICAL slug of the check being decided: the 'plugin|<slug>|<bare>' envelope for plugin-declared " +
      'permissions, the core slug otherwise — exactly as the consent presentation lists them.',
  })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  permissionSlug!: string;

  @ApiProperty({
    enum: PluginGrantStatus,
    description:
      'The decision polarity. NO ROW means pending/never asked, so there is nothing to "unset" — a Denied ' +
      'decision is a durable, first-class refusal, re-decidable by a later Granted.',
  })
  @IsEnum(PluginGrantStatus, { message: i18nValidationMessage('validation.isEnum') })
  status!: PluginGrantStatus;
}
