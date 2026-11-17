import { RiskLevel } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import type { ShownRisk } from '@bge/plugin';
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString } from 'class-validator';

/**
 * The risk an install or approval read showed for one server-scope requested
 * permission (#1336). Shape-only validation: whether it is today's risk is
 * the service's call, and a stale one answers 409 PLUGIN_CONSENT_ACT_STALE.
 */
export class ShownRiskDto implements ShownRisk {
  @ApiProperty({
    description:
      "Canonical slug of the requested permission: the 'plugin|<slug>|<bare>' form for a permission the plugin " +
      'declares, the core slug otherwise, exactly as the read lists it.',
  })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  permissionSlug!: string;

  @ApiProperty({ enum: RiskLevel, description: 'The risk level the read showed for this permission.' })
  @IsEnum(RiskLevel, { message: i18nValidationMessage('validation.isEnum') })
  riskLevel!: RiskLevel;
}
