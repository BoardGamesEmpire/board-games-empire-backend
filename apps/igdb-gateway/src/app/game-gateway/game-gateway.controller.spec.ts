import { Test, TestingModule } from '@nestjs/testing';
import { GameGatewayController } from './game-gateway.controller';
import { GameGatewayService } from './game-gateway.service';

describe('GameGatewayController', () => {
  let controller: GameGatewayController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GameGatewayController],
      providers: [GameGatewayService],
    }).compile();

    controller = module.get<GameGatewayController>(GameGatewayController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
