import { GameMedium } from '@bge/database';
import { CappedPaginationQueryDto, TransformBoolean } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDate, IsEnum, IsOptional } from 'class-validator';

/** Page-size ceiling because collections join platform/game rows. */
const GAME_COLLECTION_MAX_PAGE_SIZE = 100;

// Build the capped base once and share it: each factory call mints a distinct
// anonymous class, so calling it per-DTO would give the two queries unrelated
// base types and duplicate their Swagger schema / reflection metadata.
class GameCollectionPaginationQueryDto extends CappedPaginationQueryDto(GAME_COLLECTION_MAX_PAGE_SIZE) {}

export class ListGameCollectionsQueryDto extends GameCollectionPaginationQueryDto {
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
export class ListUserGameCollectionsQueryDto extends GameCollectionPaginationQueryDto {
  @ApiPropertyOptional({ enum: GameMedium, description: 'Filter by medium' })
  @IsOptional()
  @IsEnum(GameMedium)
  medium?: GameMedium;
}
