import { createPrismaAbility } from '@casl/prisma';
import { Test, type TestingModule } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import type { AppAbility } from '../interfaces';
import { ABILITIES_CLS_KEY, AbilityContextInternalService } from './ability-context-internal.service';

describe('AbilityContextInternalService', () => {
  let service: AbilityContextInternalService;
  let store: Map<string, unknown>;

  beforeEach(async () => {
    store = new Map<string, unknown>();

    const clsStub = {
      get: jest.fn((key: string) => store.get(key)),
      set: jest.fn((key: string, value: unknown) => store.set(key, value)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [AbilityContextInternalService, { provide: ClsService, useValue: clsStub }],
    }).compile();

    service = module.get(AbilityContextInternalService);
  });

  afterEach(() => jest.clearAllMocks());

  it('peek() returns null before anything is primed', () => {
    expect(service.peek()).toBeNull();
  });

  it('prime() stores the abilities under the documented CLS key', () => {
    const abilities = [createPrismaAbility([]) as AppAbility];

    service.prime(abilities);

    expect(store.get(ABILITIES_CLS_KEY)).toBe(abilities);
  });

  it('peek() returns the primed abilities round-trip', () => {
    const abilities = [createPrismaAbility([{ action: 'read', subject: 'Household' }]) as AppAbility];

    service.prime(abilities);

    expect(service.peek()).toBe(abilities);
  });

  it('peek() returns an empty array verbatim when primed empty (denial, not "unprimed")', () => {
    service.prime([]);

    expect(service.peek()).toEqual([]);
    expect(service.peek()).not.toBeNull();
  });
});
