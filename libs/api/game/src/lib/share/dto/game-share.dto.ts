import type { GameShare } from '@bge/database';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** A game's share with one user or one household (#810), as the share routes return it. */
export class GameShareDto implements GameShare {
  @ApiProperty({ description: 'Unique share identifier' })
  id!: string;

  @ApiProperty({ description: 'ID of the shared game' })
  gameId!: string;

  @ApiPropertyOptional({
    description: 'ID of the user the game is shared with. Exactly one of `userId` and `householdId` is set.',
    nullable: true,
  })
  userId!: string | null;

  @ApiPropertyOptional({
    description: 'ID of the household the game is shared with. Exactly one of `userId` and `householdId` is set.',
    nullable: true,
  })
  householdId!: string | null;

  @ApiPropertyOptional({
    description: 'ID of the user who shared the game: the person who created it. Null once that account is deleted.',
    nullable: true,
  })
  sharedById!: string | null;

  @ApiPropertyOptional({
    description:
      "ID of the household owner or admin who approved a member's share. Null for a share that took effect " +
      'at once, and for one still waiting.',
    nullable: true,
  })
  approvedById!: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description:
      'When the share took effect. Null while a member’s share to a household waits for a household owner or ' +
      'admin to approve it, and until then it shows the game to nobody.',
    nullable: true,
  })
  approvedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

export class GameShareResponseDto {
  @ApiProperty({ type: GameShareDto })
  share!: GameShareDto;
}
