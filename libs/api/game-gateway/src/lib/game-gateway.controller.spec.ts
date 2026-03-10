import { Test } from '@nestjs/testing';
import { GameGatewayController } from './game-gateway.controller';
import { GameGatewayService } from './game-gateway.service';

describe('GameGatewayController', () => {
  let controller: GameGatewayController;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [GameGatewayService],
      controllers: [GameGatewayController],
    }).compile();

    controller = module.get(GameGatewayController);
  });

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });
});
