import type { Mocked } from 'jest-mock';
import * as jest from 'jest-mock';

/**
 * Redeclaring here to avoid a circular dependency on the real AbilityService in permissions lib
 */
declare class AbilityService {
  getCurrentResourceConditions(resourceType: string, action: string): unknown[];
  getResourceConditionsForAbilities(abilities: unknown[], resourceType: string, action: string): unknown[];
  getCurrentAbilities(): unknown[];
  getActingUserId(): string;
  getTriggeringUserAbility(): unknown | null;
  primeCurrentActor(): Promise<void>;
}

/** Stable sentinel returned by the mocked condition resolvers, so specs can
 *  assert it flows into a Prisma `where.AND` without hand-rolling a value. */
export const MOCK_RESOURCE_CONDITION = { __mockAbilityCondition: true } as const;

/** Default acting user id returned by the mocked `getActingUserId`. */
export const MOCK_ACTING_USER_ID = 'mock-acting-user-id';

/** The subset of AbilityService consumed by feature services/guards. */
export type MockAbilityService = Mocked<
  Pick<
    AbilityService,
    | 'getCurrentResourceConditions'
    | 'getResourceConditionsForAbilities'
    | 'getCurrentAbilities'
    | 'getActingUserId'
    | 'getTriggeringUserAbility'
    | 'primeCurrentActor'
  >
>;

/**
 * Creates a typed AbilityService mock with sensible, non-throwing defaults:
 * condition resolvers return `[MOCK_RESOURCE_CONDITION]` (a non-empty filter,
 * never the dangerous `AND: []`), `getActingUserId` returns
 * `MOCK_ACTING_USER_ID`. Override per spec via the returned jest.fns or the
 * `overrides` argument.
 *
 * @example
 *   abilityService = createMockAbilityService();
 *   // providers: { provide: AbilityService, useValue: abilityService }
 *   expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Game, Action.read);
 */
export function createMockAbilityService(overrides: Partial<MockAbilityService> = {}): MockAbilityService {
  return {
    getCurrentResourceConditions: jest
      .fn<AbilityService['getCurrentResourceConditions']>()
      .mockReturnValue([MOCK_RESOURCE_CONDITION]),
    getResourceConditionsForAbilities: jest
      .fn<AbilityService['getResourceConditionsForAbilities']>()
      .mockReturnValue([MOCK_RESOURCE_CONDITION]),
    getCurrentAbilities: jest.fn<AbilityService['getCurrentAbilities']>().mockReturnValue([]),
    getActingUserId: jest.fn<AbilityService['getActingUserId']>().mockReturnValue(MOCK_ACTING_USER_ID),
    getTriggeringUserAbility: jest.fn<AbilityService['getTriggeringUserAbility']>().mockReturnValue(null),
    primeCurrentActor: jest.fn<AbilityService['primeCurrentActor']>().mockResolvedValue(undefined),
    ...overrides,
  };
}
