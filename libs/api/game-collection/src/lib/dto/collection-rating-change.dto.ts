import type { CollectionRatingChange } from '@bge/database';
import { ApiProperty, PickType } from '@nestjs/swagger';
import type { RatingRevisionValues } from '../collection-revisions';
import { restoredRatingOf } from '../collection-revisions';
import { formatPartialDate, partialDateFromColumns } from '../values/partial-date';

/** A rating change as the rating history reads it (#1231). */
export type RatingChangeRow = Pick<
  CollectionRatingChange,
  'createdAt' | 'id' | 'occurredOn' | 'occurredOnPrecision' | 'rating' | 'retractedAt'
>;

/**
 * One change of an entry's rating, as the entry's owner reads it (#1231). A change
 * with no `rating` is the rating being cleared. A change taken back is listed,
 * flagged by `retractedAt`.
 */
export class CollectionRatingChangeDto {
  @ApiProperty({ description: 'Unique rating change identifier' })
  id!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: 10,
    description: 'The rating from then on (1-10). Null when the change cleared the rating.',
  })
  rating!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'When the rating changed, as exactly as known: a year (`2019`), a month (`2019-03`) or a day ' +
      '(`2019-03-02`). Null when unknown.',
    example: '2019-03-02',
  })
  occurredOn!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When you took the change back, saying it never happened. Null unless taken back. The entry’s current ' +
      'rating stays as it is.',
  })
  retractedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', description: 'When the change was recorded' })
  createdAt!: Date;
}

/** The entry owner's shape of a rating change: its date at its own precision (#1231). */
export function toCollectionRatingChangeDto(row: RatingChangeRow): CollectionRatingChangeDto {
  const occurred = partialDateFromColumns(row.occurredOn, row.occurredOnPrecision);

  return {
    createdAt: row.createdAt,
    id: row.id,
    occurredOn: occurred === null ? null : formatPartialDate(occurred),
    rating: row.rating,
    retractedAt: row.retractedAt,
  };
}

export class CollectionRatingChangeMessageResponseDto {
  @ApiProperty({ type: CollectionRatingChangeDto })
  ratingChange!: CollectionRatingChangeDto;

  @ApiProperty({ example: 'Rating change added successfully' })
  message!: string;
}

export class CollectionRatingListResponseDto {
  @ApiProperty({
    type: [CollectionRatingChangeDto],
    description:
      'Every change of the entry’s rating, oldest first, the ones with no known date before the rest. Changes ' +
      'taken back are listed, with `retractedAt`.',
  })
  ratings!: CollectionRatingChangeDto[];
}

/**
 * What a rating change said before a correction, in the shape the entry's owner reads
 * the change (#1231): its rating and its date at its precision. Whether it is
 * taken back is no part of it.
 */
export class CollectionRatingRevisionValuesDto extends PickType(CollectionRatingChangeDto, [
  'occurredOn',
  'rating',
] as const) {}

/** A revision of a rating change: what it said before the entry's owner corrected it (#1231). */
export class CollectionRatingRevisionDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'When the correction that kept this revision was made',
  })
  createdAt!: Date;

  @ApiProperty({ description: 'Unique revision identifier' })
  id!: string;

  @ApiProperty({ type: CollectionRatingRevisionValuesDto, description: 'What the change said before the correction' })
  values!: CollectionRatingRevisionValuesDto;
}

/** A revision in the entry owner's shape (#1231). */
export function toCollectionRatingRevisionDto(
  revision: { createdAt: Date; id: string },
  values: RatingRevisionValues,
): CollectionRatingRevisionDto {
  const { occurredOn, rating } = restoredRatingOf(values);

  return {
    createdAt: revision.createdAt,
    id: revision.id,
    values: { occurredOn: occurredOn === null ? null : formatPartialDate(occurredOn), rating },
  };
}

export class CollectionRatingRevisionListResponseDto {
  @ApiProperty({ type: [CollectionRatingRevisionDto], description: "The change's revisions, newest first" })
  revisions!: CollectionRatingRevisionDto[];
}
