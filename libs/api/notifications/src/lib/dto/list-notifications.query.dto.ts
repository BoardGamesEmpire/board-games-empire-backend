import { CappedCursorPaginationQueryDto } from '@bge/shared';

/**
 * Query for `GET /notifications`: `limit` (default 25, at most 100) and the
 * opaque `cursor` a previous page returned (#1597).
 */
export class ListNotificationsQueryDto extends CappedCursorPaginationQueryDto() {}
