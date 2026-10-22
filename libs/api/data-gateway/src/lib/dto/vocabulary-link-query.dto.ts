import { VocabularyLinkStatus } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { DefaultPaginationQueryDto, TransformList } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsIn, IsOptional } from 'class-validator';

export class VocabularyLinkQueryDto extends DefaultPaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Comma-separated statuses to list. Pending when left out: the links still waiting on a review.',
    enum: VocabularyLinkStatus,
    enumName: 'VocabularyLinkStatus',
    isArray: true,
  })
  @IsOptional()
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  // `?status=` reads as [], which would list nothing at all.
  @ArrayNotEmpty({ message: i18nValidationMessage('validation.arrayNotEmpty') })
  @IsIn(Object.values(VocabularyLinkStatus), { each: true, message: i18nValidationMessage('validation.each.isIn') })
  @TransformList()
  status?: VocabularyLinkStatus[];
}
