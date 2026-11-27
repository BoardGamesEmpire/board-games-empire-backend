import { GameCondition, GameRemovalReason } from '@bge/database';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { OwnerCopyRow } from '../collection-row';
import type { Money } from '../values/money';
import { moneyFromColumns } from '../values/money';
import { formatPartialDate, partialDateFromColumns } from '../values/partial-date';
import { MoneyDto } from './money.dto';

/** A copy's edition: the release's name and year (#1231). */
export class CollectionReleaseSummaryDto {
  @ApiProperty({ description: 'Unique release identifier' })
  id!: string;

  @ApiPropertyOptional({ description: 'Edition name (e.g. "5th Edition Deluxe")', nullable: true })
  editionName!: string | null;

  @ApiPropertyOptional({ description: 'Year of this release', nullable: true })
  releaseYear!: number | null;
}

/**
 * One copy of a game, as the entry's owner reads it (#1231): its edition and
 * condition, its acquisition, what it is worth, a note, its removal, and
 * whether it was taken back. Dates are sent at their own precision, prices
 * as minor units and a currency.
 */
export class CollectionCopyDto {
  @ApiProperty({ description: 'Unique copy identifier' })
  id!: string;

  @ApiProperty({ type: CollectionReleaseSummaryDto, nullable: true, description: "The copy's edition" })
  release!: CollectionReleaseSummaryDto | null;

  @ApiProperty({ enum: GameCondition, nullable: true, description: 'The condition of a physical copy' })
  condition!: GameCondition | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'When the copy was acquired, as exactly as known: a year (`2019`), a month (`2019-03`) or a day ' +
      '(`2019-03-02`). Null when unknown.',
    example: '2019-03',
  })
  acquiredOn!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Where the copy came from, in your own words' })
  acquiredFrom!: string | null;

  @ApiProperty({ type: MoneyDto, nullable: true, description: 'What was paid for the copy' })
  pricePaid!: Money | null;

  @ApiProperty({ type: MoneyDto, nullable: true, description: 'What the copy is worth now, as you value it' })
  currentValue!: Money | null;

  @ApiProperty({ type: String, nullable: true, description: 'A note about the copy, kept as written, in Markdown' })
  note!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the removal was recorded. Null while you still own the copy.',
  })
  removedAt!: Date | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'When the copy left your collection, as exactly as known: a year, a month or a day',
    example: '2024-06',
  })
  removedOn!: string | null;

  @ApiProperty({ enum: GameRemovalReason, nullable: true, description: 'Why the copy left your collection' })
  removeReason!: GameRemovalReason | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When you took the copy back, saying you never had it: it counts as neither owned nor removed. Null ' +
      'unless taken back. Only the copies list shows a copy taken back.',
  })
  retractedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

/** The entry owner's shape of a copy row: each date at its precision, each price as one value (#1231). */
export function toCollectionCopyDto(row: OwnerCopyRow): CollectionCopyDto {
  const acquired = partialDateFromColumns(row.acquiredOn, row.acquiredOnPrecision);
  const removed = partialDateFromColumns(row.removedOn, row.removedOnPrecision);

  return {
    id: row.id,
    release: row.release,
    condition: row.condition,
    acquiredOn: acquired === null ? null : formatPartialDate(acquired),
    acquiredFrom: row.acquiredFrom,
    pricePaid: moneyFromColumns(row.pricePaidAmount, row.pricePaidCurrency),
    currentValue: moneyFromColumns(row.currentValueAmount, row.currentValueCurrency),
    note: row.note,
    removedAt: row.removedAt,
    removedOn: removed === null ? null : formatPartialDate(removed),
    removeReason: row.removeReason,
    retractedAt: row.retractedAt,
    createdAt: row.createdAt,
  };
}

export class CollectionCopyListResponseDto {
  @ApiProperty({ type: [CollectionCopyDto], description: 'Every copy the entry holds, oldest first' })
  copies!: CollectionCopyDto[];
}

export class CollectionCopyMessageResponseDto {
  @ApiProperty({ type: CollectionCopyDto })
  copy!: CollectionCopyDto;

  @ApiProperty({ example: 'Copy added successfully' })
  message!: string;
}
