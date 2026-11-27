import { GameCondition } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ClientRequestIdProperty } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { MoneyDto } from './money.dto';
import { IsPartialDate } from './partial-date.decorator';

/** The longest "where from" a copy keeps, in characters (#1231). */
export const COPY_ACQUIRED_FROM_MAX_LENGTH = 200;

/** The longest note a copy keeps, in characters (#1231). */
export const COPY_NOTE_MAX_LENGTH = 10000;

/**
 * One copy of a game, as a user describes it when they add it (#1231): its
 * edition, its condition, its acquisition, what it is worth, and a note.
 * Every field is optional, and one left out is unknown. Whether the
 * acquisition date has come yet, whether a currency is a real one, and
 * whether the edition is a release of the entry's platform game are the
 * service's to judge, where a refusal can carry its own code.
 *
 * The `copy` of `POST /game-collections` is this alone: that add is safe to
 * repeat already, as an entry still owned gets no copy from it.
 */
export class CollectionCopyDescriptionDto {
  @ApiPropertyOptional({ description: "The copy's edition: a release of the entry's platform game" })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  releaseId?: string;

  @ApiPropertyOptional({
    enum: GameCondition,
    description: 'The condition of a physical copy. A digital copy has none (code COLLECTION_CONDITION_DIGITAL).',
  })
  @IsOptional()
  @IsEnum(GameCondition, { message: i18nValidationMessage('validation.isEnum') })
  condition?: GameCondition;

  @ApiPropertyOptional({
    description:
      'When the copy was acquired, as exactly as known: a year (`2019`), a month (`2019-03`) or a day ' +
      '(`2019-03-02`). Left out, the date is unknown. A day that hasn’t begun anywhere on Earth yet is refused ' +
      '(code COLLECTION_DATE_IN_FUTURE). ' +
      'Only you see it.',
    example: '2019-03',
  })
  @IsOptional()
  @IsPartialDate()
  acquiredOn?: string;

  @ApiPropertyOptional({
    description: 'Where the copy came from, in your own words: a shop, a friend, a trade. Only you see it.',
    maxLength: COPY_ACQUIRED_FROM_MAX_LENGTH,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(COPY_ACQUIRED_FROM_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  acquiredFrom?: string;

  @ApiPropertyOptional({
    type: MoneyDto,
    description:
      'What was paid for the copy. Only you see it. An unknown currency is refused ' +
      '(code COLLECTION_CURRENCY_UNKNOWN).',
  })
  @IsOptional()
  @IsObject({ message: i18nValidationMessage('validation.isObject') })
  @ValidateNested()
  @Type(() => MoneyDto)
  pricePaid?: MoneyDto;

  @ApiPropertyOptional({
    type: MoneyDto,
    description:
      'What the copy is worth now, as you value it. Only you see it. An unknown currency is refused ' +
      '(code COLLECTION_CURRENCY_UNKNOWN).',
  })
  @IsOptional()
  @IsObject({ message: i18nValidationMessage('validation.isObject') })
  @ValidateNested()
  @Type(() => MoneyDto)
  currentValue?: MoneyDto;

  @ApiPropertyOptional({
    description: 'A note about the copy, kept as written, in Markdown. Only you see it.',
    maxLength: COPY_NOTE_MAX_LENGTH,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(COPY_NOTE_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  note?: string;
}

/**
 * The body of `POST /game-collections/:id/copies` (#1231): a copy as the user
 * describes it, and the key that makes the add safe to repeat (#252). A
 * correction of the copy takes no key, so `UpdateCollectionCopyDto` has none.
 */
export class CreateCollectionCopyDto extends CollectionCopyDescriptionDto {
  @ClientRequestIdProperty(
    'copy',
    'For a copy the key is narrower still, kept per collection entry: the same key sent to another entry adds a ' +
      "copy there. A repeat answers the copy as it stands now, even one you've removed " +
      'since, and adds no copy, so it never meets the most copies an entry holds.',
  )
  clientRequestId?: string;
}
