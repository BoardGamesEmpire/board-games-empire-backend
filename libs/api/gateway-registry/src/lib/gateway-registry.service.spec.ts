import { DatabaseService } from '@bge/database';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { GATEWAY_REGISTRY_REDIS } from './constants/gateway-registry.constants';
import { GatewayCredentialsFactory } from './credentials/gateway-credentials.factory';
import { GatewayConfigEventsService } from './gateway-config-events.service';
import { GatewayRegistryService } from './gateway-registry.service';

// TODO: Failure-tracking tests, race-condition tests, and config-event integration tests

describe('GatewayRegistryService', () => {
  let service: GatewayRegistryService;

  beforeEach(async () => {
    const redisMock = {
      duplicate: () => redisMock,
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
      publish: jest.fn(),
      quit: jest.fn(),
      on: jest.fn(),
    } as unknown as Redis;

    const module = await Test.createTestingModule({
      providers: [
        GatewayRegistryService,
        GatewayCredentialsFactory,
        GatewayConfigEventsService,
        EventEmitter2,
        { provide: DatabaseService, useValue: { gameGateway: { updateMany: jest.fn() } } },
        { provide: GATEWAY_REGISTRY_REDIS, useValue: redisMock },
      ],
    }).compile();

    service = module.get(GatewayRegistryService);
  });

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  it('reports no connected gateways initially', () => {
    expect(service.connectedGatewayIds()).toEqual([]);
  });
});
