import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { IsString, ValidateIf } from 'class-validator';
import type { GameReach } from './create-game.dto';
import { CreateGameDto, GameReachProperty } from './create-game.dto';

/**
 * A patch to a game. Each field is optional, and `null` clears a nullable one.
 *
 * `title` is redeclared rather than inherited: `PartialType` adds `IsOptional`
 * to every field it copies, which skips `null` as well as a missing key, so
 * `null` reached the non-nullable column as a 500 (#1275).
 */
export class UpdateGameDto extends PartialType(OmitType(CreateGameDto, ['reach', 'title'] as const)) {
  @ApiPropertyOptional({ description: 'Title of the game' })
  @ValidateIf((_, value) => value !== undefined)
  @IsString({ message: i18nValidationMessage('validation.isString') })
  title?: string;

  @GameReachProperty()
  reach?: GameReach;
}
