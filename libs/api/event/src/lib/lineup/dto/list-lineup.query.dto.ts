import { i18nValidationMessage } from '@bge/i18n';
import { DefaultPaginationQueryDto } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** Which of an event's lineup games to list (#799): the whole lineup, or one date's. */
export class ListLineupQueryDto extends DefaultPaginationQueryDto {
  @ApiPropertyOptional({
    description:
      "A date's id. Only that date's games are listed, and none of the event's own. A date you cannot read lists nothing.",
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  occurrenceId?: string;
}
