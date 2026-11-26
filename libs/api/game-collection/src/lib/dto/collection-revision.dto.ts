import { ApiProperty, PickType } from '@nestjs/swagger';
import type { CopyRevisionValues } from '../collection-revisions';
import { restoredCopyOf } from '../collection-revisions';
import { formatPartialDate } from '../values/partial-date';
import type { CollectionReleaseSummaryDto } from './collection-copy.dto';
import { CollectionCopyDto } from './collection-copy.dto';

/**
 * What a copy said before a correction, in the shape its owner reads the copy
 * (#1231): dates at their precision, prices as one value, and the edition's
 * name and year. When the user last edited the copy, and the upstream account
 * that synced it, are no part of it.
 */
export class CollectionRevisionValuesDto extends PickType(CollectionCopyDto, [
  'acquiredFrom',
  'acquiredOn',
  'condition',
  'currentValue',
  'note',
  'pricePaid',
  'release',
  'removedAt',
  'removedOn',
  'removeReason',
] as const) {}

/** A revision of a copy: what it said before its owner corrected it (#1231). */
export class CollectionRevisionDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'When the correction that kept this revision was made',
  })
  createdAt!: Date;

  @ApiProperty({ description: 'Unique revision identifier' })
  id!: string;

  @ApiProperty({
    type: CollectionRevisionValuesDto,
    description:
      'What the copy said before the correction. An edition deleted since reads as none, and restoring the ' +
      'revision gives the copy none.',
  })
  values!: CollectionRevisionValuesDto;
}

/**
 * A revision in its owner's shape (#1231). `release` is the edition its
 * values name, as it is now, or null when they name none or it has been
 * deleted since.
 */
export function toCollectionRevisionDto(
  revision: { createdAt: Date; id: string },
  values: CopyRevisionValues,
  release: CollectionReleaseSummaryDto | null,
): CollectionRevisionDto {
  const { description, removal } = restoredCopyOf(values);

  return {
    createdAt: revision.createdAt,
    id: revision.id,
    values: {
      ...description,
      release,
      removedAt: removal.removedAt,
      removedOn: removal.removedOn === null ? null : formatPartialDate(removal.removedOn),
      removeReason: removal.removeReason,
    },
  };
}

export class CollectionRevisionListResponseDto {
  @ApiProperty({ type: [CollectionRevisionDto], description: "The copy's revisions, newest first" })
  revisions!: CollectionRevisionDto[];
}
