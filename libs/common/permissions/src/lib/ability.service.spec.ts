import { type Actor, AuditContextService } from '@bge/actor-context';
import { Action, ResourceType } from '@bge/database';
import { ExtractSubjectType, SubjectRawRule } from '@casl/ability';
import { createPrismaAbility, PrismaQuery } from '@casl/prisma';
import { ForbiddenException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { AbilityFactory } from './ability.factory';
import { AbilityService } from './ability.service';
import type { ApikeyWithScopes, AppAbility, Subjects, UserWithRoles } from './interfaces';
import { PermissionsService } from './permissions.service';
import { AbilityContextInternalService } from './services/ability-context-internal.service';

describe('AbilityService', () => {
  let service: AbilityService;
  let auditContext: jest.Mocked<Pick<AuditContextService, 'getActor'>>;
  let abilityContext: jest.Mocked<Pick<AbilityContextInternalService, 'prime' | 'peek'>>;
  let permissionsService: jest.Mocked<Pick<PermissionsService, 'getUserRoleGraph' | 'getApiKeyScopeGraph'>>;
  let abilityFactory: jest.Mocked<Pick<AbilityFactory, 'createForUser' | 'createForApiKey' | 'createForSystem'>>;

  const ability = (rules: SubjectRawRule<Action, ExtractSubjectType<Subjects>, PrismaQuery>[]): AppAbility =>
    createPrismaAbility(rules) as AppAbility;

  beforeEach(async () => {
    auditContext = { getActor: jest.fn() };
    abilityContext = { prime: jest.fn(), peek: jest.fn() };
    permissionsService = { getUserRoleGraph: jest.fn(), getApiKeyScopeGraph: jest.fn() };
    abilityFactory = { createForUser: jest.fn(), createForApiKey: jest.fn(), createForSystem: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AbilityService,
        { provide: AuditContextService, useValue: auditContext },
        { provide: AbilityContextInternalService, useValue: abilityContext },
        { provide: PermissionsService, useValue: permissionsService },
        { provide: AbilityFactory, useValue: abilityFactory },
      ],
    }).compile();

    service = module.get(AbilityService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('getCurrentAbilities', () => {
    it('returns the primed ability array', () => {
      const primed = [ability([])];
      abilityContext.peek.mockReturnValue(primed);

      expect(service.getCurrentAbilities()).toBe(primed);
    });

    it('throws a plain Error (not ForbiddenException) when nothing is primed', () => {
      abilityContext.peek.mockReturnValue(null);

      expect(() => service.getCurrentAbilities()).toThrow('No abilities are present in the current context');
      expect(() => service.getCurrentAbilities()).not.toThrow(ForbiddenException);
    });

    it('returns an empty array when primed empty (authenticated, no abilities)', () => {
      abilityContext.peek.mockReturnValue([]);

      expect(service.getCurrentAbilities()).toEqual([]);
    });
  });

  describe('getResourceConditionsForAbilities', () => {
    it('produces one permissive clause per ability that grants the action', () => {
      const abilities = [ability([{ action: Action.read, subject: 'Household' }])];

      const conditions = service.getResourceConditionsForAbilities(abilities, ResourceType.Household, Action.read);

      expect(conditions).toEqual([{}]);
    });

    it('does NOT default the action to read — a read-only ability denies delete', () => {
      const abilities = [ability([{ action: Action.read, subject: 'Household' }])];

      const conditions = service.getResourceConditionsForAbilities(abilities, ResourceType.Household, Action.delete);

      // deny-all clause, not a permissive {} — proves the action was honoured
      expect(conditions).toEqual([{ OR: [] }]);
    });

    it('preserves each ability as its own clause — the key restriction is not collapsed into the owner grant', () => {
      // Owner grants Household unconditionally; the key is pinned to one id. The
      // two abilities must map to two DISTINCT clauses so the caller's AND
      // intersects down to the floor (the key's id), never a permissive match-all.
      const owner = ability([{ action: Action.read, subject: 'Household' }]);
      const key = ability([{ action: Action.read, subject: 'Household', conditions: { id: 'hh-1' } }]);

      const conditions = service.getResourceConditionsForAbilities([owner, key], ResourceType.Household, Action.read);

      expect(conditions).toHaveLength(2);
      expect(conditions[0]).toEqual({}); // owner: unconditional → permissive clause
      expect(conditions[1]).not.toEqual({}); // key: restricted, NOT match-all
      expect(JSON.stringify(conditions[1])).toContain('hh-1');
    });

    it('throws ForbiddenException on an empty ability array (prevents AND: [])', () => {
      expect(() => service.getResourceConditionsForAbilities([], ResourceType.Household, Action.read)).toThrow(
        ForbiddenException,
      );
    });
  });

  describe('getCurrentResourceConditions', () => {
    it('is equivalent to getResourceConditionsForAbilities for the primed actor', () => {
      const abilities = [ability([{ action: Action.read, subject: 'Household' }])];
      abilityContext.peek.mockReturnValue(abilities);

      const current = service.getCurrentResourceConditions(ResourceType.Household, Action.read);
      const explicit = service.getResourceConditionsForAbilities(abilities, ResourceType.Household, Action.read);

      expect(current).toEqual(explicit);
    });

    it('throws ForbiddenException when the primed array is empty', () => {
      abilityContext.peek.mockReturnValue([]);

      expect(() => service.getCurrentResourceConditions(ResourceType.Household, Action.read)).toThrow(
        ForbiddenException,
      );
    });

    describe('primeCurrentActor', () => {
      it('resolves and primes abilities for a user actor', async () => {
        const userAbility = ability([]);
        auditContext.getActor.mockReturnValue({ kind: 'user', userId: 'user-1' });
        permissionsService.getUserRoleGraph.mockResolvedValue({ id: 'user-1' } as UserWithRoles);
        abilityFactory.createForUser.mockReturnValue(userAbility);

        await service.primeCurrentActor();

        expect(abilityContext.prime).toHaveBeenCalledWith([userAbility]);
      });

      it('primes [] for an unauthenticated request without resolving', async () => {
        auditContext.getActor.mockReturnValue(null);

        await service.primeCurrentActor();

        expect(permissionsService.getUserRoleGraph).not.toHaveBeenCalled();
        expect(abilityContext.prime).toHaveBeenCalledWith([]);
      });

      it('primes [] for a deferred actor kind (anonymous) without resolving', async () => {
        auditContext.getActor.mockReturnValue({ kind: 'anonymous', userId: 'anon-1' });

        await service.primeCurrentActor();

        expect(abilityContext.prime).toHaveBeenCalledWith([]);
      });

      it('propagates a resolution failure and does not prime (revoked api key)', async () => {
        auditContext.getActor.mockReturnValue({ kind: 'apiKey', apiKeyId: 'gone', userId: 'u' });
        permissionsService.getUserRoleGraph.mockResolvedValue({ id: 'u' } as UserWithRoles);
        abilityFactory.createForUser.mockReturnValue(ability([]));
        permissionsService.getApiKeyScopeGraph.mockResolvedValue(null);

        await expect(service.primeCurrentActor()).rejects.toThrow(ForbiddenException);
        expect(abilityContext.prime).not.toHaveBeenCalled();
      });
    });
  });

  describe('resolveAbilitiesForActor', () => {
    it('user → [userAbility]', async () => {
      const graph = { id: 'user-1' } as UserWithRoles;
      const userAbility = ability([]);
      permissionsService.getUserRoleGraph.mockResolvedValue(graph);
      abilityFactory.createForUser.mockReturnValue(userAbility);

      const actor: Actor = { kind: 'user', userId: 'user-1' };
      const result = await service.resolveAbilitiesForActor(actor);

      expect(permissionsService.getUserRoleGraph).toHaveBeenCalledWith('user-1');
      expect(abilityFactory.createForUser).toHaveBeenCalledWith(graph);
      expect(result).toEqual([userAbility]);
    });

    it('apiKey → [ownerUserAbility, apiKeyAbility] in that order', async () => {
      const ownerAbility = ability([{ action: Action.read, subject: 'Household' }]);
      const keyAbility = ability([{ action: Action.read, subject: 'Event' }]);
      permissionsService.getUserRoleGraph.mockResolvedValue({ id: 'owner-1' } as UserWithRoles);
      abilityFactory.createForUser.mockReturnValue(ownerAbility);
      permissionsService.getApiKeyScopeGraph.mockResolvedValue({ id: 'key-1' } as ApikeyWithScopes);
      abilityFactory.createForApiKey.mockReturnValue(keyAbility);

      const actor: Actor = { kind: 'apiKey', apiKeyId: 'key-1', userId: 'owner-1' };
      const result = await service.resolveAbilitiesForActor(actor);

      expect(permissionsService.getUserRoleGraph).toHaveBeenCalledWith('owner-1');
      expect(permissionsService.getApiKeyScopeGraph).toHaveBeenCalledWith('key-1');
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(ownerAbility);
      expect(result[1]).toBe(keyAbility);
    });

    it('apiKey → ForbiddenException when the key cannot be loaded (revoked)', async () => {
      permissionsService.getUserRoleGraph.mockResolvedValue({ id: 'owner-1' } as UserWithRoles);
      abilityFactory.createForUser.mockReturnValue(ability([]));
      permissionsService.getApiKeyScopeGraph.mockResolvedValue(null);

      const actor: Actor = { kind: 'apiKey', apiKeyId: 'gone', userId: 'owner-1' };

      await expect(service.resolveAbilitiesForActor(actor)).rejects.toThrow(ForbiddenException);
    });

    it('system → [systemAbility], passing reason to the factory', async () => {
      const systemAbility = ability([{ action: Action.manage, subject: 'all' }]);
      abilityFactory.createForSystem.mockReturnValue(systemAbility);

      const actor: Actor = { kind: 'system', reason: 'cron:occurrence-cleanup' };
      const result = await service.resolveAbilitiesForActor(actor);

      expect(abilityFactory.createForSystem).toHaveBeenCalledWith('cron:occurrence-cleanup');
      expect(result).toEqual([systemAbility]);
    });

    it('anonymous → throws (deferred, never returns [])', async () => {
      const actor: Actor = { kind: 'anonymous', userId: 'anon-1' };

      await expect(service.resolveAbilitiesForActor(actor)).rejects.toThrow(/not implemented/i);
    });

    it('external → throws (audit-only, no query surface)', async () => {
      const actor: Actor = { kind: 'external', system: 'igdb-gateway', identifier: 'svc-1' };

      await expect(service.resolveAbilitiesForActor(actor)).rejects.toThrow(/no ability surface/i);
    });

    it('plugin → throws (deferred to plugin loader)', async () => {
      const actor: Actor = { kind: 'plugin', pluginId: 'plugin-1', trigger: { kind: 'user', userId: 'user-1' } };

      await expect(service.resolveAbilitiesForActor(actor)).rejects.toThrow(/not implemented/i);
    });
  });

  describe('getTriggeringUserAbility', () => {
    it('returns the owner ability (index 0) for an apiKey actor', () => {
      const owner = ability([{ action: Action.read, subject: 'Household' }]);
      const key = ability([{ action: Action.read, subject: 'Event' }]);
      auditContext.getActor.mockReturnValue({ kind: 'apiKey', apiKeyId: 'k', userId: 'u' });
      abilityContext.peek.mockReturnValue([owner, key]);

      expect(service.getTriggeringUserAbility()).toBe(owner);
    });

    it('returns null for a user actor (the principal, not a delegation)', () => {
      auditContext.getActor.mockReturnValue({ kind: 'user', userId: 'u' });
      abilityContext.peek.mockReturnValue([ability([])]);

      expect(service.getTriggeringUserAbility()).toBeNull();
    });

    it('returns null for a system actor', () => {
      auditContext.getActor.mockReturnValue({ kind: 'system', reason: 'cron' });
      abilityContext.peek.mockReturnValue([ability([{ action: Action.manage, subject: 'all' }])]);

      expect(service.getTriggeringUserAbility()).toBeNull();
    });

    it('returns null when there is no actor', () => {
      auditContext.getActor.mockReturnValue(null);

      expect(service.getTriggeringUserAbility()).toBeNull();
    });
  });
});
