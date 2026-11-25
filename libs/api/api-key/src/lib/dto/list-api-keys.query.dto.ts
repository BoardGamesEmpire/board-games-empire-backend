import { CappedPaginationQueryDto } from '@bge/shared';

/** `GET /api/api-keys`'s paging: 20 keys a page unless `limit` says otherwise, at most 50 (#1418). */
export class ListApiKeysQueryDto extends CappedPaginationQueryDto(50, 20) {}
