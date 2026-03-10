import { Test } from '@nestjs/testing';
import { GameGatewayService } from './game-gateway.service';

describe('GameGatewayService', () => {
  let service: GameGatewayService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [GameGatewayService],
    }).compile();

    service = module.get(GameGatewayService);
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });
});
