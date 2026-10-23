import { i18nValidationMessage } from '@bge/i18n';
import { IsUUID } from 'class-validator';
import { SearchFieldsDto } from './search-fields.dto';

/**
 * A WebSocket game search. A frame sends its lists as arrays, so none is
 * split from a comma-separated string as REST's are (#565).
 */
export class SearchStartDto extends SearchFieldsDto {
  @IsUUID(undefined, { message: i18nValidationMessage('validation.isUUID') })
  correlationId!: string;

  // `limit` (capped at 100, local page size 20 when absent) and `offset` (bounded
  // by DEFAULT_MAX_OFFSET, default 0) are inherited from
  // CappedOffsetPaginationQueryDto — see #17 and #403. Offset-native for the same
  // reason as SearchQueryDto (#230).
}

export class SearchCancelDto {
  @IsUUID(undefined, { message: i18nValidationMessage('validation.isUUID') })
  correlationId!: string;
}
