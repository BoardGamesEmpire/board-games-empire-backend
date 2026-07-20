import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsInt, Max, Min, ValidateIf } from 'class-validator';
import { IsCidrArray, IsHostnameOrWildcardArray } from './validators';

/**
 * Partial update for the `SafeHttpPolicy` singleton row. PATCH semantics:
 * fields omitted from the request remain unchanged; explicit empty arrays
 * clear the corresponding list.
 *
 * Cross-field validation (strict mode rejecting wildcards) happens in the
 * service layer because it depends on the effective post-update state,
 * which a single-field validator can't see.
 */
export class UpdateSafeHttpPolicyDto {
  @ApiProperty({ /* unchanged */ minimum: 1000, maximum: 300_000 })
  @ValidateIf((_, value) => value !== undefined)
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1000, { message: i18nValidationMessage('validation.min') })
  @Max(300_000, { message: i18nValidationMessage('validation.max') })
  defaultTimeoutMs?: number;

  @ApiProperty({ /* unchanged */ minimum: 0, maximum: 20 })
  @ValidateIf((_, value) => value !== undefined)
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(0, { message: i18nValidationMessage('validation.min') })
  @Max(20, { message: i18nValidationMessage('validation.max') })
  defaultMaxRedirects?: number;

  @ApiProperty({
    /* unchanged */
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  strictMode?: boolean;

  @ApiProperty({ /* unchanged */ type: [String], example: ['jenkins.local', 'minio.internal'] })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsHostnameOrWildcardArray()
  allowedHosts?: string[];

  @ApiProperty({ /* unchanged */ type: [String], example: ['10.0.0.0/8', 'fc00::/7'] })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsCidrArray()
  allowedCidrs?: string[];

  @ApiProperty({ /* unchanged */ type: [String] })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsHostnameOrWildcardArray()
  blockedHosts?: string[];

  @ApiProperty({ /* unchanged */ type: [String] })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsCidrArray()
  blockedCidrs?: string[];
}
