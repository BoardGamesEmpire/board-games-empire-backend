import { CappedPaginationQueryDto } from '@bge/shared';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

/**
 * Ceiling on the page size, formerly UserService.MAX_SEARCH_RESULTS.
 *
 * It is NOT a ceiling on results any more, whatever the old name suggested:
 * page-based paging means a caller can walk past it a page at a time, bounded
 * only by the shared derived-skip ceiling. What it still buys is the #11
 * self-DoS floor — one request cannot ask for an unbounded text match.
 */
export const USER_SEARCH_MAX_RESULTS = 20;

// UserService used to clamp `take` to 20 and default it to 10. Both belong here
// now that `skip` is derived from the resolved page size — see #230 — and an
// over-large `limit` is rejected rather than quietly reduced.
export class UserSearchQueryDto extends CappedPaginationQueryDto(USER_SEARCH_MAX_RESULTS, 10) {
  @ApiProperty({ description: 'Search term matched against username and first name', minLength: 2 })
  @IsString()
  @MinLength(2)
  q!: string;
}
