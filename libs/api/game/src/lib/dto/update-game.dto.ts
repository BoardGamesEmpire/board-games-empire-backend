import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateGameDto, GameReachProperty, type GameReach } from './create-game.dto';

export class UpdateGameDto extends PartialType(OmitType(CreateGameDto, ['reach'] as const)) {
  @GameReachProperty()
  reach?: GameReach;
}
