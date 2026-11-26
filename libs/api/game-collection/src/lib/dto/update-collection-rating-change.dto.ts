import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min, ValidateIf } from 'class-validator';
import { RATING_MAX, RATING_MIN } from './create-collection-rating-change.dto';
import { IsPartialDate } from './partial-date.decorator';

/**
 * A correction of one rating change (#1231). A field left out keeps its
 * value. `rating: null` makes the change a clearing of the rating, and
 * `occurredOn: null` makes its date unknown. Neither changes the entry's
 * current rating.
 */
export class UpdateCollectionRatingChangeDto {
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: RATING_MIN,
    maximum: RATING_MAX,
    description: 'The rating from then on (1-10); null makes the change a clearing of the rating.',
  })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(RATING_MIN, { message: i18nValidationMessage('validation.min') })
  @Max(RATING_MAX, { message: i18nValidationMessage('validation.max') })
  rating?: number | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'When the rating changed, as exactly as known: a year (`2019`), a month (`2019-03`) or a day ' +
      '(`2019-03-02`); null makes it unknown. A day that hasn’t begun anywhere on Earth yet is refused ' +
      '(code COLLECTION_DATE_IN_FUTURE).',
    example: '2019-03',
  })
  @IsOptional()
  @IsPartialDate()
  occurredOn?: string | null;
}
