import type { GameCollection } from '@bge/database';
import { GameMedium, GameRemovalReason, Visibility } from '@bge/database';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CollectionGameSummaryDto {
  @ApiProperty({ description: 'Unique game identifier' })
  id!: string;

  @ApiProperty({ description: 'Title of the game' })
  title!: string;

  @ApiPropertyOptional({ description: 'Subtitle of the game', nullable: true })
  subtitle!: string | null;

  @ApiPropertyOptional({ description: 'Full image URL', nullable: true })
  image!: string | null;

  @ApiPropertyOptional({ description: 'Thumbnail image URL', nullable: true })
  thumbnail!: string | null;
}

export class CollectionPlatformSummaryDto {
  @ApiProperty({ description: 'Unique platform identifier' })
  id!: string;

  @ApiProperty({ description: 'Platform name' })
  name!: string;

  @ApiProperty({ description: 'Platform slug' })
  slug!: string;
}

export class CollectionPlatformGameSummaryDto {
  @ApiProperty({ description: 'Unique platform-game identifier' })
  id!: string;

  @ApiPropertyOptional({ description: 'Platform-specific image override', nullable: true })
  image!: string | null;

  @ApiPropertyOptional({ description: 'Platform-specific thumbnail override', nullable: true })
  thumbnail!: string | null;

  @ApiProperty({ type: CollectionPlatformSummaryDto })
  platform!: CollectionPlatformSummaryDto;

  @ApiProperty({ type: CollectionGameSummaryDto })
  game!: CollectionGameSummaryDto;
}

export class CollectionReleaseSummaryDto {
  @ApiProperty({ description: 'Unique release identifier' })
  id!: string;

  @ApiPropertyOptional({ description: 'Edition name (e.g. "5th Edition Deluxe")', nullable: true })
  editionName!: string | null;

  @ApiPropertyOptional({ description: 'Year of this release', nullable: true })
  releaseYear!: number | null;
}

export class GameCollectionDto
  implements
    Pick<
      GameCollection,
      | 'id'
      | 'userId'
      | 'platformGameId'
      | 'releaseId'
      | 'medium'
      | 'quantity'
      | 'visibility'
      | 'rating'
      | 'playCount'
      | 'playAgain'
      | 'favorite'
      | 'comment'
      | 'lastPlayed'
      | 'lastUpdated'
      | 'deletedAt'
      | 'deleteReason'
      | 'createdAt'
      | 'updatedAt'
    >
{
  @ApiProperty({ description: 'Unique collection entry identifier' })
  id!: string;

  @ApiProperty({ description: 'ID of the owning user' })
  userId!: string;

  @ApiProperty({ description: 'ID of the platform game' })
  platformGameId!: string;

  @ApiPropertyOptional({ description: 'ID of a specific release', nullable: true })
  releaseId!: string | null;

  @ApiProperty({ enum: GameMedium, description: 'Medium of the owned copy' })
  medium!: GameMedium;

  @ApiProperty({ description: 'Number of copies owned' })
  quantity!: number;

  @ApiProperty({ enum: Visibility, description: 'Who may see this entry beyond the owner' })
  visibility!: Visibility;

  @ApiPropertyOptional({ description: 'Personal rating (1-10)', nullable: true })
  rating!: number | null;

  @ApiPropertyOptional({ description: 'Number of recorded plays (server-managed)', nullable: true })
  playCount!: number | null;

  @ApiPropertyOptional({ description: 'Whether the user would play again', nullable: true })
  playAgain!: boolean | null;

  @ApiPropertyOptional({ description: 'Whether the game is a favorite', nullable: true })
  favorite!: boolean | null;

  @ApiPropertyOptional({ description: 'Personal comment', nullable: true })
  comment!: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', description: 'Last recorded play', nullable: true })
  lastPlayed!: Date | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', description: 'Last user-driven change', nullable: true })
  lastUpdated!: Date | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'When the entry was removed (null while owned)',
    nullable: true,
  })
  deletedAt!: Date | null;

  @ApiPropertyOptional({ enum: GameRemovalReason, description: 'Why the game left the collection', nullable: true })
  deleteReason!: GameRemovalReason | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ type: CollectionPlatformGameSummaryDto })
  platformGame!: CollectionPlatformGameSummaryDto;

  @ApiPropertyOptional({ type: CollectionReleaseSummaryDto, nullable: true })
  release!: CollectionReleaseSummaryDto | null;
}

export class GameCollectionListResponseDto {
  @ApiProperty({ type: [GameCollectionDto] })
  collections!: GameCollectionDto[];
}

export class GameCollectionResponseDto {
  @ApiProperty({ type: GameCollectionDto })
  collection!: GameCollectionDto;
}

export class GameCollectionMessageResponseDto {
  @ApiProperty({ type: GameCollectionDto })
  collection!: GameCollectionDto;

  @ApiProperty({ example: 'Game added to collection successfully' })
  message!: string;
}
