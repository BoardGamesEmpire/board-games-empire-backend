import { Test, type TestingModule } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import { AbilityService } from '../ability.service';
import { AbilityContextMiddleware } from './ability-context.middleware';

describe('AbilityContextMiddleware', () => {
  let middleware: AbilityContextMiddleware;
  let abilityService: jest.Mocked<Pick<AbilityService, 'primeCurrentActor'>>;

  const req = {} as Request;
  const res = {} as Response;
  let next: jest.MockedFunction<NextFunction>;

  beforeEach(async () => {
    abilityService = { primeCurrentActor: jest.fn() };
    next = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [AbilityContextMiddleware, { provide: AbilityService, useValue: abilityService }],
    }).compile();

    middleware = module.get(AbilityContextMiddleware);
  });

  afterEach(() => jest.clearAllMocks());

  it('primes the current actor then calls next()', async () => {
    abilityService.primeCurrentActor.mockResolvedValue(undefined);

    await middleware.use(req, res, next);

    expect(abilityService.primeCurrentActor).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it('forwards priming errors to next() rather than throwing', async () => {
    const error = new Error('database unavailable');
    abilityService.primeCurrentActor.mockRejectedValue(error);

    await middleware.use(req, res, next);

    expect(next).toHaveBeenCalledWith(error);
  });
});
