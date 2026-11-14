import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsNotEmpty, IsString } from 'class-validator';
import { LISTS_MAX_PER_USER } from '../list.constants';

/**
 * The whole new order of the acting user's lists, in one request. It must
 * name exactly the lists they hold now, or the route answers 409
 * `LIST_ORDER_STALE` and writes nothing (#1241).
 */
export class ReorderListsDto {
  @ApiProperty({
    type: [String],
    maxItems: LISTS_MAX_PER_USER,
    description: 'Every one of your list ids, first to last',
  })
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @ArrayMaxSize(LISTS_MAX_PER_USER, { message: i18nValidationMessage('validation.arrayMaxSize') })
  @ArrayUnique({ message: i18nValidationMessage('validation.arrayUnique') })
  @IsString({ each: true, message: i18nValidationMessage('validation.each.isString') })
  @IsNotEmpty({ each: true, message: i18nValidationMessage('validation.each.isNotEmpty') })
  listIds!: string[];
}
