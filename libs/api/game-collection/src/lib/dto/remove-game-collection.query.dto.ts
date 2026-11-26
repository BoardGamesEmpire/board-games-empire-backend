import { GameRemovalReason } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { IsPartialDate } from './partial-date.decorator';

export class RemoveGameCollectionQueryDto {
  @ApiPropertyOptional({ enum: GameRemovalReason, description: 'Why the game left the collection' })
  @IsOptional()
  @IsEnum(GameRemovalReason, { message: i18nValidationMessage('validation.isEnum') })
  reason?: GameRemovalReason;

  @ApiPropertyOptional({
    description:
      'When the game left the collection, as exactly as known: a year (`2019`), a month (`2019-03`) or a day ' +
      '(`2019-03-02`). Left out, the removal is dated today (UTC). A day that hasn’t begun anywhere on Earth yet is refused ' +
      '(code COLLECTION_DATE_IN_FUTURE), and so is a date before a copy was acquired (code COLLECTION_DATE_ORDER).',
    example: '2019-03',
  })
  @IsOptional()
  @IsPartialDate()
  removedOn?: string;
}
