import { i18nValidationMessage } from '@bge/i18n';
import { ClientRequestIdProperty } from '@bge/shared';
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min, ValidateIf } from 'class-validator';
import { IsPartialDate } from './partial-date.decorator';

/** The lowest personal rating (#1231). */
export const RATING_MIN = 1;

/** The highest personal rating (#1231). */
export const RATING_MAX = 10;

/**
 * An earlier change of an entry's rating, as its owner adds it (#1231): what
 * the rating became, and when. Both are required: a change with no `rating`
 * is the rating being cleared, and says so by sending `null`. The date is
 * judged against the clock by the service, where a refusal can carry its code.
 * Adding one never changes the entry's current rating. The key makes the add
 * safe to repeat (ADR 0002, #1231); a correction of the change takes none, so
 * `UpdateCollectionRatingChangeDto` has none.
 */
export class CreateCollectionRatingChangeDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: RATING_MIN,
    maximum: RATING_MAX,
    description: 'The rating from then on (1-10). Send null for a change that cleared the rating.',
  })
  @ValidateIf((_, value) => value !== null)
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(RATING_MIN, { message: i18nValidationMessage('validation.min') })
  @Max(RATING_MAX, { message: i18nValidationMessage('validation.max') })
  rating!: number | null;

  @ApiProperty({
    type: String,
    description:
      'When the rating changed, as exactly as known: a year (`2019`), a month (`2019-03`) or a day ' +
      '(`2019-03-02`). A day that hasn’t begun anywhere on Earth yet is refused (code COLLECTION_DATE_IN_FUTURE).',
    example: '2019-03-02',
  })
  @IsPartialDate()
  occurredOn!: string;

  @ClientRequestIdProperty(
    'rating change',
    'For a rating change the key is kept per collection entry: the same key sent to another entry adds a ' +
      "change there. A repeat answers the change as it stands now, even one you've taken back since, and adds nothing.",
  )
  clientRequestId?: string;
}
