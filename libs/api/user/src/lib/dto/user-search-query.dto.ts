import { CappedPaginationQueryDto } from '@bge/shared';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

/** Hard ceiling on search results, formerly UserService.MAX_SEARCH_RESULTS. */
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
