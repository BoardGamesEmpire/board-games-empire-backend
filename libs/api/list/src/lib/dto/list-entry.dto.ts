import { ContentType, PlatformType, WishlistPriority } from '@bge/database';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ListEntryRow } from '../list-entry-row';

type EntryGame = NonNullable<ListEntryRow['game']>;
type EntryPlatformGame = NonNullable<ListEntryRow['platformGame']>;
type EntryPlatform = EntryPlatformGame['platform'];
type EntryRelease = NonNullable<ListEntryRow['release']>;

/**
 * The game an entry shows. Each class here implements the row's type, and the
 * service returns these DTOs, so a field on one side only fails the typecheck
 * (#1241).
 */
export class ListEntryGameDto implements EntryGame {
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

  @ApiProperty({
    enum: ContentType,
    enumName: 'ContentType',
    description: 'Content classification (base game, expansion, etc.)',
  })
  contentType!: ContentType;

  @ApiProperty({ type: Number, nullable: true, description: 'Year the game was published' })
  publishYear!: number | null;
}

export class ListEntryPlatformDto implements EntryPlatform {
  @ApiProperty({ description: 'Unique platform identifier' })
  id!: string;

  @ApiProperty({ description: 'Platform name' })
  name!: string;

  @ApiProperty({ description: 'Platform slug' })
  slug!: string;

  @ApiProperty({ enum: PlatformType, enumName: 'PlatformType', description: 'Kind of platform' })
  platformType!: PlatformType;
}

export class ListEntryPlatformGameDto implements EntryPlatformGame {
  @ApiProperty({ description: 'Unique platform-game identifier' })
  id!: string;

  @ApiPropertyOptional({ description: 'Platform-specific image override', nullable: true })
  image!: string | null;

  @ApiPropertyOptional({ description: 'Platform-specific thumbnail override', nullable: true })
  thumbnail!: string | null;

  @ApiProperty({ type: ListEntryPlatformDto })
  platform!: ListEntryPlatformDto;

  @ApiProperty({ type: ListEntryGameDto })
  game!: ListEntryGameDto;
}

export class ListEntryReleaseDto implements EntryRelease {
  @ApiProperty({ description: 'Unique release identifier' })
  id!: string;

  @ApiPropertyOptional({ description: 'Edition name (e.g. "5th Edition Deluxe")', nullable: true })
  editionName!: string | null;

  @ApiPropertyOptional({ type: Number, description: 'Year of this release', nullable: true })
  releaseYear!: number | null;
}

/**
 * A list entry as the routes send it. It names a game on any platform or one
 * platform game, so exactly one of `game` and `platformGame` is set (#1241).
 */
export class ListEntryDto implements ListEntryRow {
  @ApiProperty({ description: 'Unique list entry identifier' })
  id!: string;

  @ApiProperty({ description: 'ID of the list the entry is on' })
  listId!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The game, on any platform; null when a platform game' })
  gameId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The platform game; null when a game on any platform' })
  platformGameId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'A release of the platform game' })
  releaseId!: string | null;

  @ApiProperty({
    description:
      "The entry's place on its list, in the order the list's owner chose. Order by it, then by `id`; never index " +
      'by it: a removed entry leaves a gap until the next reorder.',
  })
  position!: number;

  @ApiProperty({
    enum: WishlistPriority,
    enumName: 'WishlistPriority',
    nullable: true,
    description: 'How much the user wants the game. Only ever set on a wishlist’s entries.',
  })
  priority!: WishlistPriority | null;

  @ApiProperty({ type: String, nullable: true, description: 'Note, in Markdown, stored as written' })
  note!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ type: ListEntryGameDto, nullable: true, description: 'Set when the entry names a game' })
  game!: ListEntryGameDto | null;

  @ApiProperty({
    type: ListEntryPlatformGameDto,
    nullable: true,
    description: 'Set when the entry names a platform game',
  })
  platformGame!: ListEntryPlatformGameDto | null;

  @ApiProperty({ type: ListEntryReleaseDto, nullable: true })
  release!: ListEntryReleaseDto | null;
}

export class ListEntryMessageResponseDto {
  @ApiProperty({ type: ListEntryDto })
  entry!: ListEntryDto;

  @ApiProperty({ example: 'List entry added successfully' })
  message!: string;
}

export class ListEntriesResponseDto {
  @ApiProperty({ type: [ListEntryDto], description: "The list's entries, in their new order" })
  entries!: ListEntryDto[];
}

export class ListEntryDeletedResponseDto {
  @ApiProperty({ example: 'List entry removed successfully' })
  message!: string;
}
