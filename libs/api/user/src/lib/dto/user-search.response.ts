import { ApiProperty } from '@nestjs/swagger';
import type { UserSearchResult } from '../interfaces/user-search-results.interface';

type UserSearchProfile = NonNullable<UserSearchResult['profile']>;

/**
 * The profile fields a search result carries. Null as a whole when the user has
 * no profile row — the search filters on `profile.isSearchable`, but the
 * relation is still optional on the model, so the nullability is real.
 */
class UserSearchProfileDto implements UserSearchProfile {
  @ApiProperty({ type: String, nullable: true, description: 'Chosen display name' })
  displayName!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Profile avatar URL' })
  avatarUrl!: string | null;
}

/**
 * OpenAPI model for one `GET /users/search` row.
 *
 * `implements UserSearchResult` is the guard that matters: the search's Prisma
 * `select` and this class describe the same shape from two directions, and
 * without it a field added to the select would be served undocumented. The
 * pattern is the one #354 established for the plugin inventory rows.
 *
 * Deliberately narrow — id, username, name, image and the public profile. This
 * endpoint is readable by any authenticated user, so anything added here is
 * added to what one user learns about another.
 */
export class UserSearchResultDto implements UserSearchResult {
  @ApiProperty({ description: 'User identifier' })
  id!: string;

  @ApiProperty({ description: 'Unique username, and the sort key for results' })
  username!: string;

  @ApiProperty({ type: String, nullable: true })
  firstName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  lastName!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Account image URL' })
  image!: string | null;

  @ApiProperty({ type: UserSearchProfileDto, nullable: true })
  profile!: UserSearchProfile | null;
}
