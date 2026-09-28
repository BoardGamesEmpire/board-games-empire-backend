import { i18nValidationMessage } from '@bge/i18n-core';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { DefaultPaginationQueryDto } from './capped-pagination-query.dto';

export class SearchQueryDto extends DefaultPaginationQueryDto {
  @ApiProperty({ description: 'Search terms matched against resource fields', minLength: 2 })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MinLength(2, { message: i18nValidationMessage('validation.minLength') })
  q!: string;
}
