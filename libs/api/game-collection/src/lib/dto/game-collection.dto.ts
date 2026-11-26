import type { GameCollection } from '@bge/database';
import { ContentType, GameCondition, GameMedium, GameRemovalReason, PlatformType, Reach } from '@bge/database';
import { ExpansionLinkDto } from '@bge/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { GameCollectionRow, PublicCopyRow } from '../collection-row';
import type { Money } from '../values/money';
import type { CollectionCopyDto } from './collection-copy.dto';
import { CollectionReleaseSummaryDto } from './collection-copy.dto';
import { MoneyDto } from './money.dto';

type CollectionPlatformGame = GameCollectionRow['platformGame'];
type CollectionPlatform = CollectionPlatformGame['platform'];
type CollectionGame = CollectionPlatformGame['game'];

/**
 * The game a collection row embeds: what a list shows, filters and sorts on
 * (#1070). It implements the row's type, and the service returns this DTO, so
 * a field on one side only fails the typecheck.
 */
export class CollectionGameSummaryDto implements CollectionGame {
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

  @ApiProperty({ type: Number, nullable: true, description: 'Minimum number of players' })
  minPlayers!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Maximum number of players' })
  maxPlayers!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Minimum play time, in minutes' })
  minPlayTime!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Maximum play time, in minutes' })
  maxPlayTime!: number | null;

  @ApiProperty({
    type: [ExpansionLinkDto],
    description:
      'For an add-on, the base games it attaches to that are live, that the viewer could open by id, and that ' +
      'have a platform game on this row’s platform (#1391), in title order, then game id, each with the add-on’s ' +
      '`isStandalone` on this platform. Empty for any other game.',
  })
  baseGames!: ExpansionLinkDto[];
}

export class CollectionPlatformSummaryDto implements CollectionPlatform {
  @ApiProperty({ description: 'Unique platform identifier' })
  id!: string;

  @ApiProperty({ description: 'Platform name' })
  name!: string;

  @ApiProperty({ description: 'Platform slug' })
  slug!: string;

  @ApiProperty({ enum: PlatformType, enumName: 'PlatformType', description: 'Kind of platform' })
  platformType!: PlatformType;
}

export class CollectionPlatformGameSummaryDto implements CollectionPlatformGame {
  @ApiProperty({ description: 'Unique platform-game identifier' })
  id!: string;

  @ApiPropertyOptional({ description: 'Platform-specific image override', nullable: true })
  image!: string | null;

  @ApiPropertyOptional({ description: 'Platform-specific thumbnail override', nullable: true })
  thumbnail!: string | null;

  @ApiProperty({
    enum: ContentType,
    enumName: 'ContentType',
    nullable: true,
    description:
      'This platform game’s own content type, which overrides the game’s on this platform. Null when it has none, ' +
      'and the game’s applies (#1391).',
  })
  contentType!: ContentType | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: "Minimum number of players, a platform-specific override; when null, use the game's value",
  })
  minPlayers!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: "Maximum number of players, a platform-specific override; when null, use the game's value",
  })
  maxPlayers!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: "Minimum play time in minutes, a platform-specific override; when null, use the game's value",
  })
  minPlayTime!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: "Maximum play time in minutes, a platform-specific override; when null, use the game's value",
  })
  maxPlayTime!: number | null;

  @ApiProperty({ type: CollectionPlatformSummaryDto })
  platform!: CollectionPlatformSummaryDto;

  @ApiProperty({ type: CollectionGameSummaryDto })
  game!: CollectionGameSummaryDto;
}

/**
 * `Partial<T>` when `Row` names exactly the fields of `T`. Otherwise a type
 * naming the fields on one side only, so a class that implements it fails the
 * typecheck and names them (#1231).
 */
type EveryFieldOf<T, Row> = [Exclude<keyof T, keyof Row>, Exclude<keyof Row, keyof T>] extends [never, never]
  ? Partial<T>
  : { fieldsOnOneSideOnly: [Exclude<keyof T, keyof Row>, Exclude<keyof Row, keyof T>] };

/**
 * A copy on a collection row (#1231). Every reader of the entry gets its id,
 * edition and condition. The owner, reading their own entries, also gets
 * every other field the copy routes send; no one else ever does.
 *
 * It implements the include's public copy, and names every field of the
 * owner's copy, so a field added to either without this class fails the
 * typecheck.
 */
export class CollectionRowCopyDto implements PublicCopyRow, EveryFieldOf<CollectionCopyDto, CollectionRowCopyDto> {
  @ApiProperty({ description: 'Unique copy identifier' })
  id!: string;

  @ApiProperty({ type: CollectionReleaseSummaryDto, nullable: true, description: "The copy's edition" })
  release!: CollectionReleaseSummaryDto | null;

  @ApiProperty({ enum: GameCondition, nullable: true, description: 'The condition of a physical copy' })
  condition!: GameCondition | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Sent to the owner only. When the copy was acquired, as exactly as known: a year (`2019`), a month ' +
      '(`2019-03`) or a day (`2019-03-02`). Null when unknown.',
    example: '2019-03',
  })
  acquiredOn?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Sent to the owner only. Where the copy came from, in your own words',
  })
  acquiredFrom?: string | null;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description: 'Sent to the owner only. What was paid for the copy',
  })
  pricePaid?: Money | null;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description: 'Sent to the owner only. What the copy is worth now, as you value it',
  })
  currentValue?: Money | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Sent to the owner only. A note about the copy, kept as written, in Markdown',
  })
  note?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Sent to the owner only. When the removal was recorded: always null on a row, which lists owned copies',
  })
  removedAt?: Date | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Sent to the owner only. When the copy left your collection: always null on a row',
  })
  removedOn?: string | null;

  @ApiPropertyOptional({
    enum: GameRemovalReason,
    nullable: true,
    description: 'Sent to the owner only. Why the copy left your collection: always null on a row',
  })
  removeReason?: GameRemovalReason | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Sent to the owner only. When the copy was recorded',
  })
  createdAt?: Date;
}

export class GameCollectionDto implements Pick<
  GameCollection,
  | 'id'
  | 'userId'
  | 'platformGameId'
  | 'medium'
  | 'reach'
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
> {
  @ApiProperty({ description: 'Unique collection entry identifier' })
  id!: string;

  @ApiProperty({ description: 'ID of the owning user' })
  userId!: string;

  @ApiProperty({ description: 'ID of the platform game' })
  platformGameId!: string;

  @ApiProperty({ enum: GameMedium, description: 'Medium of the owned copy' })
  medium!: GameMedium;

  @ApiProperty({ description: 'Number of copies the owner still has', readOnly: true })
  quantity!: number;

  @ApiProperty({
    type: [CollectionRowCopyDto],
    readOnly: true,
    description:
      'The copies the owner still has, oldest first. Every reader sees each one’s id, edition and condition. The ' +
      'owner also gets the rest on `GET /game-collections`, `GET /game-collections/:id` and the answers to their ' +
      'writes; `GET /users/:userId/game-collections` sends every caller the first three only.',
  })
  copies!: CollectionRowCopyDto[];

  @ApiProperty({
    enum: Reach,
    enumName: 'Reach',
    description: 'Who may see this entry besides its owner and the households they share their games with',
  })
  reach!: Reach;

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

  @ApiPropertyOptional({
    type: Boolean,
    nullable: true,
    description:
      'Sent on `GET /users/:userId/game-collections` only: whether this game is on your wishlist. A wishlisted ' +
      'game matches every platform game of it; a wishlisted platform game matches only itself. Null, never false, ' +
      'when you have no wishlist you can read: as an anonymous user, a plugin, or an API key whose list grant ' +
      'does not reach your wishlist.',
  })
  onWishlist?: boolean | null;
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
