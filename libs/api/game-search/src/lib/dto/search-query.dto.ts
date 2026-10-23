import { PlatformType } from '@bge/database';
import { TransformList } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { SEARCHABLE_CONTENT_TYPES, type SearchableContentType } from '../search-filter';
import { SearchFieldsDto } from './search-fields.dto';

/**
 * A REST game search. The list fields are redeclared only to split a
 * comma-separated query string: their validators stay on the base (#565).
 */
export class SearchQueryDto extends SearchFieldsDto {
  @ApiPropertyOptional({
    description: 'Comma-separated gateway IDs to include. Empty = all active gateways.',
    type: String,
  })
  @TransformList()
  override gatewayIds?: string[];

  @ApiPropertyOptional({
    description:
      'Comma-separated platform types. Only games on a platform of one of them are found, ' +
      'so a page can come back shorter than the limit.',
    enum: PlatformType,
    isArray: true,
  })
  @TransformList()
  override platformTypes?: PlatformType[];

  @ApiPropertyOptional({
    description:
      'Comma-separated content types. Only games of one of them are found, ' +
      'so a page can come back shorter than the limit.',
    enum: SEARCHABLE_CONTENT_TYPES,
    isArray: true,
  })
  @TransformList()
  override contentTypes?: SearchableContentType[];

  // `limit` (capped at 100, local page size 20 when absent) and `offset` (bounded
  // by DEFAULT_MAX_OFFSET, default 0) are inherited from
  // CappedOffsetPaginationQueryDto — see #17 and #403. Search stays
  // offset-native rather than page-based because the value is forwarded to
  // gateways and their upstream vendor APIs unchanged (#230).
}
