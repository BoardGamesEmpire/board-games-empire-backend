import { GatewayConfigEventsService } from '@bge/gateway-registry';
import { createTestingModuleWithDb } from '@bge/testing';
import { ConfigModule } from '@nestjs/config';
import { GameGatewayService } from './game-gateway.service';

describe('GameGatewayService', () => {
  let service: GameGatewayService;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        GameGatewayService,
        {
          provide: GatewayConfigEventsService,
          useValue: {
            publish: jest.fn(),
            subscribe: jest.fn(),
          } satisfies Partial<jest.Mocked<GatewayConfigEventsService>>,
        },
      ],
    });

    service = module.get(GameGatewayService);
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });
});
