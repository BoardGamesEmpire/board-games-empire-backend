import { GameMedium } from '@bge/database';
import { PaginationQueryDto, TransformBoolean } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDate, IsEnum, IsOptional, Max } from 'class-validator';

/** Pagination with a hard page-size ceiling (collections join platform/game rows). */
class CappedPaginationQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Maximum entries per page', maximum: 100 })
  @Max(100)
  declare limit?: number;
}

export class ListGameCollectionsQueryDto extends CappedPaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Include removed (previously owned) entries alongside active ones',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  @TransformBoolean()
  includeDeleted?: boolean;

  @ApiPropertyOptional({
    description: 'Return only removed (previously owned) entries — the resurrection view',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  @TransformBoolean()
  deletedOnly?: boolean;

  @ApiPropertyOptional({ enum: GameMedium, description: 'Filter by medium' })
  @IsOptional()
  @IsEnum(GameMedium)
  medium?: GameMedium;

  @ApiPropertyOptional({ description: 'Return only favorites' })
  @IsOptional()
  @IsBoolean()
  @TransformBoolean()
  favorite?: boolean;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Only entries updated at or after this time — delta-sync support (combine with includeDeleted)',
  })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  updatedSince?: Date;
}

/** Query for viewing another user's collection — no tombstone access. */
export class ListUserGameCollectionsQueryDto extends CappedPaginationQueryDto {
  @ApiPropertyOptional({ enum: GameMedium, description: 'Filter by medium' })
  @IsOptional()
  @IsEnum(GameMedium)
  medium?: GameMedium;
}
