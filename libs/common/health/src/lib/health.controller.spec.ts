import { PassThroughGuard } from '@bge/testing';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';
import { Test } from '@nestjs/testing';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), TerminusModule, HttpModule],
      providers: [
        {
          provide: AuthGuard,
          useClass: PassThroughGuard,
        },
      ],
      controllers: [HealthController],
    }).compile();

    controller = module.get(HealthController);
  });

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });
});
