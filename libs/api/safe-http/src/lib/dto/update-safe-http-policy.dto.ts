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
  @IsInt()
  @Min(1000)
  @Max(300_000)
  defaultTimeoutMs?: number;

  @ApiProperty({ /* unchanged */ minimum: 0, maximum: 20 })
  @ValidateIf((_, value) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(20)
  defaultMaxRedirects?: number;

  @ApiProperty({
    /* unchanged */
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  strictMode?: boolean;

  @ApiProperty({ /* unchanged */ type: [String], example: ['jenkins.local', 'minio.internal'] })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @IsHostnameOrWildcardArray()
  allowedHosts?: string[];

  @ApiProperty({ /* unchanged */ type: [String], example: ['10.0.0.0/8', 'fc00::/7'] })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @IsCidrArray()
  allowedCidrs?: string[];

  @ApiProperty({ /* unchanged */ type: [String] })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @IsHostnameOrWildcardArray()
  blockedHosts?: string[];

  @ApiProperty({ /* unchanged */ type: [String] })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @IsCidrArray()
  blockedCidrs?: string[];
}
