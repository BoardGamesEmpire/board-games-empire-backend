import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNumberString, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * Body for `PATCH /quotas/:scope/:scopeId/:resource`. Scope, scope target,
 * and resource come from the route; this carries the cap itself.
 *
 * `limit` is a non-negative integer *string* — bigint cannot be expressed in
 * JSON without precision loss, so it crosses the wire as a decimal string and
 * the service parses it to bigint.
 */
export class SetQuotaDto {
  @ApiPropertyOptional({
    description: 'Non-negative integer limit as a decimal string (bigint). Required on create, optional when updating.',
    example: '5368709120',
  })
  @IsOptional()
  @IsNumberString({ no_symbols: true }, { message: 'limit must be a non-negative integer string' })
  limit?: string;

  @ApiPropertyOptional({ description: 'Warn-but-allow instead of hard block. Defaults to false (hard block).' })
  @ValidateIf((dto: SetQuotaDto) => dto.softOverage !== undefined)
  @IsBoolean()
  softOverage?: boolean;

  @ApiPropertyOptional({ description: 'Master switch. False disables the cap without deleting it. Defaults to true.' })
  @ValidateIf((dto: SetQuotaDto) => dto.enforced !== undefined)
  @IsBoolean()
  enforced?: boolean;

  @ApiPropertyOptional({ description: 'Why this quota exists — UI reminder.' })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  description?: string;
}
