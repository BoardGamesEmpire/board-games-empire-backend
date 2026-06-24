import { Action } from '@bge/database';
import { IS_PUBLIC_KEY } from '@bge/shared';
import { ExtractSubjectType, SubjectRawRule } from '@casl/ability';
import { createPrismaAbility, PrismaQuery } from '@casl/prisma';
import { type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { AbilityService } from '../ability.service';
import { CHECK_POLICIES_KEY } from '../decorators';
import type { AppAbility, PolicyHandler, Subjects } from '../interfaces';
import { PoliciesGuard } from './policies.guard';

describe('PoliciesGuard', () => {
  let guard: PoliciesGuard;
  let reflector: jest.Mocked<Pick<Reflector, 'getAllAndOverride' | 'get'>>;
  let abilityService: jest.Mocked<Pick<AbilityService, 'getCurrentAbilities'>>;

  const canReadHousehold: PolicyHandler = (ability) => ability.can(Action.read, 'Household');
  const ability = (rules: SubjectRawRule<Action, ExtractSubjectType<Subjects>, PrismaQuery>[]): AppAbility =>
    createPrismaAbility(rules) as AppAbility;

  const handler = (): void => undefined;
  const context = {
    getHandler: () => handler,
    getClass: () => PoliciesGuard,
  } as unknown as ExecutionContext;

  beforeEach(async () => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false), get: jest.fn().mockReturnValue([]) };
    abilityService = { getCurrentAbilities: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PoliciesGuard,
        { provide: Reflector, useValue: reflector },
        { provide: AbilityService, useValue: abilityService },
      ],
    }).compile();

    guard = module.get(PoliciesGuard);
  });

  afterEach(() => jest.clearAllMocks());

  const withPolicies = (handlers: PolicyHandler[]): void => {
    reflector.get.mockImplementation((key) => (key === CHECK_POLICIES_KEY ? handlers : undefined));
  };

  it('allows public routes without consulting abilities', () => {
    reflector.getAllAndOverride.mockImplementation((key) => key === IS_PUBLIC_KEY);

    expect(guard.canActivate(context)).toBe(true);
    expect(abilityService.getCurrentAbilities).not.toHaveBeenCalled();
  });

  it('allows routes that declare no policy handlers', () => {
    withPolicies([]);

    expect(guard.canActivate(context)).toBe(true);
    expect(abilityService.getCurrentAbilities).not.toHaveBeenCalled();
  });

  it('denies (403) when no abilities are primed — must not vacuously pass [].every(...)', () => {
    // Covers unauthenticated and not-yet-supported actor kinds alike: both prime
    // an empty array, which the guard must treat as a denial rather than letting
    // `[].every(...) === true` grant access.
    withPolicies([canReadHousehold]);
    abilityService.getCurrentAbilities.mockReturnValue([]);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('supports object-style policy handlers (IPolicyHandler.handle)', () => {
    const objectHandler = { handle: (a: AppAbility) => a.can(Action.read, 'Household') };
    withPolicies([objectHandler]);
    abilityService.getCurrentAbilities.mockReturnValue([ability([{ action: Action.read, subject: 'Household' }])]);

    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows when the single ability satisfies every handler', () => {
    withPolicies([canReadHousehold]);
    abilityService.getCurrentAbilities.mockReturnValue([ability([{ action: Action.read, subject: 'Household' }])]);

    expect(guard.canActivate(context)).toBe(true);
  });

  it('denies when the single ability fails a handler', () => {
    withPolicies([canReadHousehold]);
    abilityService.getCurrentAbilities.mockReturnValue([ability([{ action: Action.read, subject: 'Event' }])]);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('requires EVERY ability to pass for an apiKey actor (owner AND key)', () => {
    withPolicies([canReadHousehold]);
    // Owner grants Household; key does NOT → intersection denies.
    abilityService.getCurrentAbilities.mockReturnValue([
      ability([{ action: Action.read, subject: 'Household' }]),
      ability([{ action: Action.read, subject: 'Event' }]),
    ]);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('allows an apiKey actor when both owner and key abilities pass', () => {
    withPolicies([canReadHousehold]);
    abilityService.getCurrentAbilities.mockReturnValue([
      ability([{ action: Action.read, subject: 'Household' }]),
      ability([{ action: Action.read, subject: 'Household' }]),
    ]);

    expect(guard.canActivate(context)).toBe(true);
  });
});
