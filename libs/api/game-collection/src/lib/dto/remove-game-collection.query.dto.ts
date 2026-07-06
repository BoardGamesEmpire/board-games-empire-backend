import { GameRemovalReason } from '@bge/database';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

export class RemoveGameCollectionQueryDto {
  @ApiPropertyOptional({ enum: GameRemovalReason, description: 'Why the game left the collection' })
  @IsOptional()
  @IsEnum(GameRemovalReason)
  reason?: GameRemovalReason;
}
