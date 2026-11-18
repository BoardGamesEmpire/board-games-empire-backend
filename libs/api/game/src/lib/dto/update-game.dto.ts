import { OmitType, PartialType } from '@nestjs/swagger';
import type { GameReach } from './create-game.dto';
import { CreateGameDto, GameReachProperty } from './create-game.dto';

export class UpdateGameDto extends PartialType(OmitType(CreateGameDto, ['reach'] as const)) {
  @GameReachProperty()
  reach?: GameReach;
}
