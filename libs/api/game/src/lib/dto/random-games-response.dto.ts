import { ApiProperty, PickType } from '@nestjs/swagger';
import { GameDto } from './game.dto';

/**
 * The game summary, the shape `GAME_SUMMARY_SELECT` reads (#960, #961). The
 * thumbnail has no alt text of its own, so the title labels it.
 */
export class GameSummaryDto extends PickType(GameDto, ['id', 'title', 'thumbnail', 'description'] as const) {}

/** `GET /games/random`: a random sample of the games the caller could list (#961). */
export class RandomGamesResponseDto {
  @ApiProperty({ type: [GameSummaryDto] })
  games!: GameSummaryDto[];
}
