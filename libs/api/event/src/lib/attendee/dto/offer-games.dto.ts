import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsOptional,
  IsString,
  registerDecorator,
  ValidateNested,
  type ValidationOptions,
} from 'class-validator';

/** The most collection entries one batch offer may name, counting expansions (#1188). */
export const OFFER_GAMES_MAX_IDS = 100;

/**
 * One game to offer, with a choice of its expansions (#1188). Each
 * expansion is its own offered entry, judged as any other and also checked
 * to expand the item's game. Nothing records that it came with the game.
 */
export class OfferGameItemDto {
  @ApiProperty({ description: 'ID of a GameCollection entry owned by the attendee: the game to offer' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  collectionId!: string;

  @ApiPropertyOptional({
    description:
      "IDs of the attendee's GameCollection entries to offer with the game, each an expansion of it. " +
      'An expansion can also be offered on its own, as an item of its own.',
    type: String,
    isArray: true,
  })
  @IsOptional()
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsString({ each: true, message: i18nValidationMessage('validation.each.isString') })
  expansionCollectionIds?: string[];
}

/** Every collection id `items` names, items and expansions alike, skipping what isn't one. */
function namedIds(items: unknown): string[] {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.flatMap((item: Partial<OfferGameItemDto> | null) => [
    ...(typeof item?.collectionId === 'string' ? [item.collectionId] : []),
    ...(Array.isArray(item?.expansionCollectionIds)
      ? item.expansionCollectionIds.filter((id): id is string => typeof id === 'string')
      : []),
  ]);
}

/**
 * Refuses a batch naming more than `cap` collection entries in all, its
 * expansions counted, and one naming any entry twice, whether as two items,
 * two expansions, or an item and an expansion (#1188). Each refusal has its
 * own constraint and message. A malformed item passes here, for its own
 * validators to say what's wrong.
 */
export function OfferedIdsWithinCap(cap: number, validationOptions?: ValidationOptions): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'offeredIdsWithinCap',
      target: object.constructor,
      propertyName: propertyName.toString(),
      constraints: [cap],
      options: { message: i18nValidationMessage('validation.offerGames.tooMany'), ...validationOptions },
      validator: { validate: (items: unknown) => namedIds(items).length <= cap },
    });

    registerDecorator({
      name: 'noRepeatedOfferedIds',
      target: object.constructor,
      propertyName: propertyName.toString(),
      options: { message: i18nValidationMessage('validation.offerGames.repeatedId'), ...validationOptions },
      validator: {
        validate: (items: unknown) => {
          const ids = namedIds(items);

          return new Set(ids).size === ids.length;
        },
      },
    });
  };
}

/** `POST /events/:eventId/attendees/:attendeeId/games/batch` (#1188). */
export class OfferGamesDto {
  @ApiProperty({
    description:
      `The games to offer, each with a choice of its expansions: at most ${OFFER_GAMES_MAX_IDS} collection ` +
      'entries in all, counting expansions, and each named once.',
    type: OfferGameItemDto,
    isArray: true,
  })
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @ArrayNotEmpty({ message: i18nValidationMessage('validation.arrayNotEmpty') })
  // Every item names at least one id, so more items than the cap is over it
  // whatever they hold. class-validator still validates each item of an array
  // that fails here, so one past the cap is all that's kept: a body of empty
  // items answers the size, not one error per item (#1188).
  @ArrayMaxSize(OFFER_GAMES_MAX_IDS, { message: i18nValidationMessage('validation.arrayMaxSize') })
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value) && value.length > OFFER_GAMES_MAX_IDS ? value.slice(0, OFFER_GAMES_MAX_IDS + 1) : value,
  )
  @ValidateNested({ each: true })
  @Type(() => OfferGameItemDto)
  @OfferedIdsWithinCap(OFFER_GAMES_MAX_IDS)
  items!: OfferGameItemDto[];
}
