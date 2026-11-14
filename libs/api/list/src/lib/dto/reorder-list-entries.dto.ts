import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsNotEmpty, IsString } from 'class-validator';
import { LIST_MAX_ENTRIES } from '../list.constants';

/**
 * The whole new order of a list's entries, in one request. It must name
 * exactly the entries the list holds now, or the route answers 409
 * `LIST_ORDER_STALE` and writes nothing (#1241).
 */
export class ReorderListEntriesDto {
  @ApiProperty({
    type: [String],
    maxItems: LIST_MAX_ENTRIES,
    description: 'Every one of the list’s entry ids, first to last',
  })
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @ArrayMaxSize(LIST_MAX_ENTRIES, { message: i18nValidationMessage('validation.arrayMaxSize') })
  @ArrayUnique({ message: i18nValidationMessage('validation.arrayUnique') })
  @IsString({ each: true, message: i18nValidationMessage('validation.each.isString') })
  @IsNotEmpty({ each: true, message: i18nValidationMessage('validation.each.isNotEmpty') })
  entryIds!: string[];
}
