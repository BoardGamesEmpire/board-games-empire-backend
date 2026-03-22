import { createTestingModuleWithDb } from '@bge/testing';
import { ConfigModule } from '@nestjs/config';
import { GameGatewayService } from './game-gateway.service';

describe('GameGatewayService', () => {
  let service: GameGatewayService;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [GameGatewayService],
    });

    service = module.get(GameGatewayService);
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });
});
