import { GameCondition, GameRemovalReason } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { COPY_ACQUIRED_FROM_MAX_LENGTH, COPY_NOTE_MAX_LENGTH } from './create-collection-copy.dto';
import { MoneyDto } from './money.dto';
import { IsPartialDate } from './partial-date.decorator';

/**
 * A correction of one copy (#1231). Standard REST PATCH semantics: a field
 * left out keeps its value, and `null` clears it, back to unknown. Each field
 * of `CollectionCopyDescriptionDto` is here, under the same rules. `removedOn`
 * and `removeReason` describe a removal, so only a removed copy takes them; a
 * removal always has a date, so `removedOn` can't be cleared. A correction
 * takes no `clientRequestId`: one that rewrote the key would strand the add's
 * retry into a second copy (ADR 0002, #534).
 */
export class UpdateCollectionCopyDto {
  @ApiPropertyOptional({
    description: "The copy's edition: a release of the entry's platform game; null clears it",
    nullable: true,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  releaseId?: string | null;

  @ApiPropertyOptional({
    enum: GameCondition,
    nullable: true,
    description:
      'The condition of a physical copy; null clears it. A digital copy has none (code COLLECTION_CONDITION_DIGITAL).',
  })
  @IsOptional()
  @IsEnum(GameCondition, { message: i18nValidationMessage('validation.isEnum') })
  condition?: GameCondition | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'When the copy was acquired, as exactly as known: a year (`2019`), a month (`2019-03`) or a day ' +
      '(`2019-03-02`); null makes it unknown. A day that hasn’t begun anywhere on Earth yet is refused ' +
      '(code COLLECTION_DATE_IN_FUTURE), and ' +
      "so is a date after the copy's removal (code COLLECTION_DATE_ORDER).",
    example: '2019-03',
  })
  @IsOptional()
  @IsPartialDate()
  acquiredOn?: string | null;

  @ApiPropertyOptional({
    description: 'Where the copy came from, in your own words; null clears it.',
    maxLength: COPY_ACQUIRED_FROM_MAX_LENGTH,
    nullable: true,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(COPY_ACQUIRED_FROM_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  acquiredFrom?: string | null;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description:
      'What was paid for the copy; null clears it. An unknown currency is refused (code COLLECTION_CURRENCY_UNKNOWN).',
  })
  @IsOptional()
  @IsObject({ message: i18nValidationMessage('validation.isObject') })
  @ValidateNested()
  @Type(() => MoneyDto)
  pricePaid?: MoneyDto | null;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description:
      'What the copy is worth now, as you value it; null clears it. An unknown currency is refused ' +
      '(code COLLECTION_CURRENCY_UNKNOWN).',
  })
  @IsOptional()
  @IsObject({ message: i18nValidationMessage('validation.isObject') })
  @ValidateNested()
  @Type(() => MoneyDto)
  currentValue?: MoneyDto | null;

  @ApiPropertyOptional({
    description: 'A note about the copy, kept as written, in Markdown; null clears it.',
    maxLength: COPY_NOTE_MAX_LENGTH,
    nullable: true,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(COPY_NOTE_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  note?: string | null;

  @ApiPropertyOptional({
    description:
      'When a removed copy left your collection, as exactly as known: a year, a month or a day. A copy you still ' +
      'own has no removal to change (code COLLECTION_COPY_NOT_REMOVED). A day that hasn’t begun anywhere on Earth yet is refused ' +
      '(code COLLECTION_DATE_IN_FUTURE), and so is a date before the copy was acquired (code COLLECTION_DATE_ORDER).',
    example: '2024-06',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsPartialDate()
  removedOn?: string;

  @ApiPropertyOptional({
    enum: GameRemovalReason,
    nullable: true,
    description:
      'Why a removed copy left your collection; null clears it. A copy you still own has no removal to change ' +
      '(code COLLECTION_COPY_NOT_REMOVED).',
  })
  @IsOptional()
  @IsEnum(GameRemovalReason, { message: i18nValidationMessage('validation.isEnum') })
  removeReason?: GameRemovalReason | null;
}
