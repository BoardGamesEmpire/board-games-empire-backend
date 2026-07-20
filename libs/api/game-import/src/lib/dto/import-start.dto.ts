import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';

export class ImportStartDto {
  @ApiProperty({ description: 'Links WS events back to the originating search session', format: 'uuid' })
  @IsUUID(undefined, { message: i18nValidationMessage('validation.isUUID') })
  correlationId!: string;

  @ApiProperty({ description: 'Gateway that owns the external game record' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  gatewayId!: string;

  @ApiProperty({ description: 'External ID of the base game on the gateway' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  externalId!: string;

  @ApiProperty({
    description: 'Locale to use when fetching game data from the gateway. Optional, as not all gateways support this.',
  })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsOptional()
  locale?: string;

  /**
   * External IDs of specific expansions to import alongside the base game.
   * Empty array = base game only. Expansions must belong to the same gateway.
   */
  @ApiProperty({ type: [String], description: 'External IDs of expansions to co-import. Empty = base game only.' })
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsString({ each: true, message: i18nValidationMessage('validation.isString') })
  @IsOptional()
  expansionExternalIds?: string[] = [];
}

export class ImportJobProgressDto {
  @IsString({ message: i18nValidationMessage('validation.isString') })
  batchId!: string;

  @IsString({ message: i18nValidationMessage('validation.isString') })
  jobId!: string;

  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @IsOptional()
  complete?: boolean;
}
