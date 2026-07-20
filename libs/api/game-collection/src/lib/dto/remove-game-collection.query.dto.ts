import { GameRemovalReason } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

export class RemoveGameCollectionQueryDto {
  @ApiPropertyOptional({ enum: GameRemovalReason, description: 'Why the game left the collection' })
  @IsOptional()
  @IsEnum(GameRemovalReason, { message: i18nValidationMessage('validation.isEnum') })
  reason?: GameRemovalReason;
}
