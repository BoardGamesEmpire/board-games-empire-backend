import { Reach } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ReachProperty, TransformTrim } from '@bge/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { LIST_MAX_DESCRIPTION_LENGTH, LIST_MAX_NAME_LENGTH } from '../list.constants';

const LIST_REACHES = [
  Reach.Private,
  Reach.Friends,
  Reach.FriendsOfFriends,
  Reach.ExtendedNetwork,
  Reach.Public,
] as const;
export type ListReach = (typeof LIST_REACHES)[number];

/**
 * A list's reach: every rung a list read rule serves (#1241). Shared with
 * `UpdateListDto`, which names no default.
 */
export function ListReachProperty(defaultReach?: ListReach): PropertyDecorator {
  return ReachProperty({
    reaches: LIST_REACHES,
    default: defaultReach,
    description:
      'Who may see this list and its entries besides its owner. `Private`: no one. `Friends`: the owner’s ' +
      'friends. `FriendsOfFriends`: the owner’s friends and friends of friends, unless a block stands between ' +
      'the owner and the reader. `ExtendedNetwork`: everyone up to three friendship steps from the owner, on ' +
      'the same condition. `Public`: every signed-in user on the server. Anonymous users cannot read lists.',
  });
}

export class CreateListDto {
  @ApiProperty({ description: 'List name', maxLength: LIST_MAX_NAME_LENGTH })
  @TransformTrim()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  @MaxLength(LIST_MAX_NAME_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  name!: string;

  @ApiPropertyOptional({ description: 'Description, in Markdown', maxLength: LIST_MAX_DESCRIPTION_LENGTH })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(LIST_MAX_DESCRIPTION_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  description?: string;

  @ListReachProperty(Reach.Private)
  reach?: ListReach;
}
