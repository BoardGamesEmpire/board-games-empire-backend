import type { CollectionRatingChange } from '@bge/database';
import { ApiProperty } from '@nestjs/swagger';
import { formatPartialDate, partialDateFromColumns } from '../values/partial-date';

/** A rating change as the rating history reads it (#1231). */
export type RatingChangeRow = Pick<
  CollectionRatingChange,
  'createdAt' | 'id' | 'occurredOn' | 'occurredOnPrecision' | 'rating'
>;

/**
 * One change of an entry's rating, as its owner reads it (#1231). A change
 * with no `rating` is the rating being cleared.
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

  @ApiProperty({ type: String, format: 'date-time', description: 'When the change was recorded' })
  createdAt!: Date;
}

/** The owner's shape of a rating change: its date at its own precision (#1231). */
export function toCollectionRatingChangeDto(row: RatingChangeRow): CollectionRatingChangeDto {
  const occurred = partialDateFromColumns(row.occurredOn, row.occurredOnPrecision);

  return {
    createdAt: row.createdAt,
    id: row.id,
    occurredOn: occurred === null ? null : formatPartialDate(occurred),
    rating: row.rating,
  };
}

export class CollectionRatingListResponseDto {
  @ApiProperty({
    type: [CollectionRatingChangeDto],
    description: 'Every change of the entry’s rating, oldest first, the ones with no known date before the rest',
  })
  ratings!: CollectionRatingChangeDto[];
}
