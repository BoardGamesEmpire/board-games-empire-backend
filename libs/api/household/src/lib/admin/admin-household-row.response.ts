import { Reach } from '@bge/database';
import { ApiProperty } from '@nestjs/swagger';
import type { AdminHouseholdOwner, AdminHouseholdRow } from './admin-household.service';

/** A household owner as one row of the staff households list names them (#419). */
export class AdminHouseholdOwnerResponse implements AdminHouseholdOwner {
  @ApiProperty({ description: 'User identifier' })
  userId!: string;

  @ApiProperty({ description: 'Unique username' })
  username!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The display name the user chose, as stored: null when they have none or have no profile',
  })
  displayName!: string | null;
}

/**
 * OpenAPI model for one row of `GET /admin/households` (#419).
 *
 * `implements AdminHouseholdRow` keeps it honest: the service's row and this
 * class describe one shape from two directions, so a field added to the row
 * and left out here fails to compile rather than ships undocumented.
 *
 * Lean on purpose: what staff need to find a household and decide whether to
 * restore it. The detail is `GET /households/:id`, and the row carries no
 * roster, since a list of every household on the server shouldn't carry
 * every member (client#683).
 */
export class AdminHouseholdRowResponse implements AdminHouseholdRow {
  @ApiProperty({ description: 'Household identifier' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Household image URL' })
  image!: string | null;

  @ApiProperty({ enum: Reach, enumName: 'Reach', description: 'Who beyond the members can see the household' })
  reach!: Reach;

  @ApiProperty({ type: Date })
  createdAt!: Date;

  @ApiProperty({ type: Date, nullable: true, description: 'When the household was deleted, or null while it is live' })
  deletedAt!: Date | null;

  @ApiProperty({ description: 'How many members the household has, owners included' })
  memberCount!: number;

  @ApiProperty({
    type: [AdminHouseholdOwnerResponse],
    description:
      'The members who are its household owners, in the order they joined. For a deleted household, its ' +
      'household owners as they stood at the delete.',
  })
  owners!: AdminHouseholdOwnerResponse[];
}
