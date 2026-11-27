import { ApiProperty } from '@nestjs/swagger';
import type { KeysetPosition } from '../pagination/keyset-cursor.js';
import { encodeKeysetCursor } from '../pagination/keyset-cursor.js';
import { assertListScopeComposed } from '../scope/assert-list-scope-composed.js';
import type { ListScope } from '../scope/list-scope.js';
import { ApiListEnvelope } from './list-envelope.js';

/**
 * Metadata attached to every cursor-paged list response. There is no `total`
 * and no `page`: a keyset read cannot know either without a count, and a
 * client's paging loop ends on `hasMore` or a `null` cursor (#1597).
 */
export class CursorPaginationMetaDto {
  @ApiProperty({ description: 'Page size used for this response', example: 25 })
  limit!: number;

  @ApiProperty({ description: 'Whether a further page exists after this one', example: true })
  hasMore!: boolean;

  @ApiProperty({
    description: 'Opaque cursor to pass as `cursor` for the next page; null on the last page',
    example: 'WyIyMDI2LTExLTI3VDEyOjAwOjAwLjAwMFoiLCJhYmMiXQ',
    nullable: true,
    type: String,
  })
  nextCursor!: string | null;
}

/** One page of a cursor read: the rows to return and where the next page starts. */
export interface CursorPage<T> {
  nextCursor: string | null;
  rows: T[];
}

/** The resolved paging a response was built with; any `CursorPaginationQueryDto` satisfies it. */
export interface ResolvedCursorPaging {
  pageSize: number;
}

export type CursorPaginatedResponse<K extends string, T> = { [P in K]: T[] } & {
  pagination: CursorPaginationMetaDto;
};

/**
 * Trims a read of `pageSize + 1` rows to a page. The extra row is how the read
 * learns whether a next page exists without a `count()`; when it is there it is
 * cut, and the cursor points at the last row kept, so the next page starts at
 * the row that was cut. With `pageSize` rows or fewer the page is the last and
 * `nextCursor` is `null` (#1597).
 */
export function cursorPage<T extends KeysetPosition>(rows: readonly T[], pageSize: number): CursorPage<T> {
  const kept = rows.slice(0, pageSize);
  const last = kept.at(-1);

  if (rows.length <= pageSize || last === undefined) {
    return { rows: kept, nextCursor: null };
  }

  return { rows: kept, nextCursor: encodeKeysetCursor(last) };
}

/**
 * Builds the cursor list envelope: the rows under their resource key, plus
 * {@link CursorPaginationMetaDto}. The sibling of `paginated()` for lists read
 * by keyset, and like it, `scope` is #365's erosion guard: the `ResourceType`
 * whose intrinsic scope the read composed, or `Unscoped('<why>')`. It is checked
 * first, so a list whose read skipped the composer throws instead of answering
 * with the actor's ceiling (#1597).
 */
export function cursorPaginated<K extends string, T>(
  resourceKey: K,
  { rows, nextCursor }: CursorPage<T>,
  { pageSize }: ResolvedCursorPaging,
  scope: ListScope,
): CursorPaginatedResponse<K, T> {
  assertListScopeComposed(resourceKey, scope);

  const pagination: CursorPaginationMetaDto = { limit: pageSize, hasMore: nextCursor !== null, nextCursor };

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a computed key of generic type `K` widens to a string index, which TypeScript can't relate to the mapped `CursorPaginatedResponse<K, T>` (#1321)
  return { [resourceKey]: rows, pagination } as CursorPaginatedResponse<K, T>;
}

/**
 * The 200 response for a cursor-paged list whose rows are not modelled here:
 * the envelope schema with `pagination` a `$ref` to
 * {@link CursorPaginationMetaDto}, plus that model's registration, as one
 * decorator (see `ApiListEnvelope` for why) (#1597).
 *
 *   ＠ApiCursorPaginatedEnvelope('notifications', { description: 'Notification history' })
 */
export function ApiCursorPaginatedEnvelope(
  resourceKey: string,
  options: { description?: string; status?: number } = {},
): MethodDecorator & ClassDecorator {
  return ApiListEnvelope(resourceKey, CursorPaginationMetaDto, options);
}
