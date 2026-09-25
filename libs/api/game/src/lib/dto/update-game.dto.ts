import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateGameDto, GameVisibilityProperty, type GameVisibility } from './create-game.dto';

export class UpdateGameDto extends PartialType(OmitType(CreateGameDto, ['visibility'] as const)) {
  @GameVisibilityProperty()
  visibility?: GameVisibility;
}
