import { Reach } from '@bge/database';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { UserProfileView } from '../profile/profile-view';

const OWNER_ONLY = "Served to the profile's owner only.";

/**
 * OpenAPI model for a profile as a viewer is served it (#819).
 *
 * `implements UserProfileView` keeps the class and the profile read's select
 * describing one shape, so a field added to the select is not served
 * undocumented.
 */
export class UserProfileResponseDto implements UserProfileView {
  @ApiProperty({ description: "The profile owner's user id" })
  userId!: string;

  @ApiProperty({ description: "The profile owner's username, their identity wherever they appear" })
  username!: string;

  @ApiProperty({ type: String, nullable: true })
  displayName!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Avatar URL' })
  avatarUrl!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Markdown' })
  bio!: string | null;

  @ApiProperty({ type: String, nullable: true })
  pronouns!: string | null;

  @ApiProperty({ type: String, nullable: true })
  location!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  preferredPlayerCount!: number | null;

  @ApiProperty()
  willingToTeach!: boolean;

  @ApiProperty()
  openToNewPlayers!: boolean;

  @ApiProperty({ type: String, nullable: true })
  houseRulesPreference!: string | null;

  @ApiProperty()
  hostingCapability!: boolean;

  @ApiPropertyOptional({ type: String, nullable: true, description: OWNER_ONLY })
  dietaryRestrictions?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: OWNER_ONLY })
  accessibilityNeeds?: string | null;

  @ApiPropertyOptional({
    enum: Reach,
    enumName: 'Reach',
    description: `Who may read the profile, and so find it in search. ${OWNER_ONLY}`,
  })
  reach?: Reach;

  @ApiPropertyOptional({ description: `Whether the profile is offered to user search. ${OWNER_ONLY}` })
  isSearchable?: boolean;
}

export class UserProfileEnvelopeDto {
  @ApiProperty({ type: UserProfileResponseDto })
  profile!: UserProfileResponseDto;
}
