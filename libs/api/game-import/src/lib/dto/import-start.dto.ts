import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';

export class ImportStartDto {
  @ApiProperty({ description: 'Links WS events back to the originating search session', format: 'uuid' })
  @IsUUID()
  correlationId!: string;

  @ApiProperty({ description: 'Gateway that owns the external game record' })
  @IsString()
  gatewayId!: string;

  @ApiProperty({ description: 'External ID of the base game on the gateway' })
  @IsString()
  externalId!: string;

  @ApiProperty({
    description: 'Locale to use when fetching game data from the gateway. Optional, as not all gateways support this.',
  })
  @IsString()
  @IsOptional()
  locale?: string;

  /**
   * External IDs of specific expansions to import alongside the base game.
   * Empty array = base game only. Expansions must belong to the same gateway.
   */
  @ApiProperty({ type: [String], description: 'External IDs of expansions to co-import. Empty = base game only.' })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  expansionExternalIds?: string[] = [];
}

export class ImportJobProgressDto {
  @IsString()
  batchId!: string;

  @IsString()
  jobId!: string;

  @IsBoolean()
  @IsOptional()
  complete?: boolean;
}
