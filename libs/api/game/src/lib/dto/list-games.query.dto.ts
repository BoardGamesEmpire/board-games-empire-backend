import { i18nValidationMessage } from '@bge/i18n';
import { DefaultPaginationQueryDto } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export const GAME_SORTS = ['title', 'newest'] as const;

export type GameSort = (typeof GAME_SORTS)[number];

/**
 * Query contract for `GET /games`: the #230 page contract plus the order
 * (#959).
 *
 * Each value names an order, not a column, and every order ends in the game
 * id, so a repeated request answers the same page while the set is unchanged.
 * No order stops a game added or removed between two requests from shifting
 * the offset pages after it. The orders reorder the same set and never narrow
 * it.
 */
export class ListGamesQueryDto extends DefaultPaginationQueryDto {
  @ApiPropertyOptional({
    enum: GAME_SORTS,
    default: 'title',
    description:
      'Order of the list. title: alphabetical (the default). newest: the games most recently added to the game catalog first.',
  })
  @IsIn(GAME_SORTS, { message: i18nValidationMessage('validation.isIn') })
  @IsOptional()
  sort: GameSort = 'title';
}
