import { LanguageLinkStatus } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { DefaultPaginationQueryDto, TransformList } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsIn, IsOptional } from 'class-validator';

export class LanguageLinkQueryDto extends DefaultPaginationQueryDto {
  @ApiPropertyOptional({
    description:
      'Comma-separated statuses to list. Pending and Unresolved when left out: the links still waiting on a review.',
    enum: LanguageLinkStatus,
    enumName: 'LanguageLinkStatus',
    isArray: true,
  })
  @IsOptional()
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  // `?status=` reads as [], which would list nothing at all.
  @ArrayNotEmpty({ message: i18nValidationMessage('validation.arrayNotEmpty') })
  @IsIn(Object.values(LanguageLinkStatus), { each: true, message: i18nValidationMessage('validation.each.isIn') })
  @TransformList()
  status?: LanguageLinkStatus[];
}
