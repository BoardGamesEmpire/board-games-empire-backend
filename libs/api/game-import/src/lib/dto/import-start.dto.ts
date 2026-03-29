import { IsArray, IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';

export class ImportStartDto {
  /**
   * Links WS events back to the originating search session
   */
  @IsUUID()
  correlationId!: string;

  @IsString()
  gatewayId!: string;

  /**
   * External ID of the base game on the gateway
   */
  @IsString()
  externalId!: string;

  /**
   * External IDs of specific expansions to import alongside the base game.
   * Empty array = base game only. Expansions must belong to the same gateway.
   */
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
