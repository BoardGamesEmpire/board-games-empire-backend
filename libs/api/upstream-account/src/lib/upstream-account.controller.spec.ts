import type { UpstreamAccount } from '@bge/database';
import { Action, ResourceType, Upstream } from '@bge/database';
import { CodedHttpException, t } from '@bge/i18n';
import type { AppAbility } from '@bge/permissions';
import { AbilityService, CHECK_POLICIES_KEY, PoliciesGuard, ScopeComposer } from '@bge/permissions';
import { CACHE_RESPONSE_KEY } from '@bge/shared';
import { createTestingModuleWithDb } from '@bge/testing';
import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Http } from '@status/codes';
import { UpstreamAccountErrorCode } from './upstream-account.constants';
import { UpstreamAccountController } from './upstream-account.controller';
import { UpstreamAccountService } from './upstream-account.service';

const ME = 'user-1';
const COND = { id: 'sentinel-condition' };

const steamAccount: UpstreamAccount = {
  id: 'ua-1',
  userId: ME,
  upstream: Upstream.Steam,
  externalId: '76561197960287930',
  displayName: null,
  profileUrl: 'https://steamcommunity.com/profiles/76561197960287930',
  verified: true,
  createdAt: new Date('2026-11-19T10:00:00.000Z'),
  updatedAt: new Date('2026-11-19T11:00:00.000Z'),
};

const privacyPolicy = { url: '/api/privacy-policy', language: 'de', updatedAt: '2026-11-18T00:00:00.000Z' };

describe('UpstreamAccountController (#935)', () => {
  let controller: UpstreamAccountController;
  const list = jest.fn();
  const linkableUpstreams = jest.fn();
  const unlink = jest.fn();
  const readPolicy = jest.fn();
  const getActingUserId = jest.fn<string, []>();
  const getCurrentResourceConditions = jest.fn();

  beforeEach(async () => {
    list.mockReset().mockResolvedValue([steamAccount]);
    linkableUpstreams.mockReset().mockResolvedValue([Upstream.Steam]);
    unlink.mockReset().mockResolvedValue(undefined);
    readPolicy.mockReset().mockResolvedValue(privacyPolicy);
    getActingUserId.mockReset().mockReturnValue(ME);
    getCurrentResourceConditions.mockReset().mockReturnValue([COND]);

    const { module } = await createTestingModuleWithDb({
      controllers: [UpstreamAccountController],
      providers: [
        // The REAL composer, over the mocked ability service, so the scopes
        // asserted below are the ones the routes compose.
        ScopeComposer,
        { provide: AbilityService, useValue: { getActingUserId, getCurrentResourceConditions } },
        {
          provide: UpstreamAccountService,
          useValue: { linkableUpstreams, list, privacyPolicy: readPolicy, unlink },
        },
      ],
      overrideGuards: [PoliciesGuard],
    });

    controller = module.get(UpstreamAccountController);
  });

  describe('list', () => {
    it('answers the accounts, the linkable upstreams and the privacy policy, by upstream key', async () => {
      await expect(controller.list('fr-CH, fr;q=0.9')).resolves.toEqual({
        upstreamAccounts: [
          {
            upstream: 'steam',
            externalId: '76561197960287930',
            displayName: null,
            profileUrl: 'https://steamcommunity.com/profiles/76561197960287930',
            verified: true,
            linkedAt: '2026-11-19T10:00:00.000Z',
          },
        ],
        linkableUpstreams: ['steam'],
        privacyPolicy,
      });

      expect(readPolicy).toHaveBeenCalledWith(ME, 'fr-CH, fr;q=0.9');
    });

    it("reads the acting user's accounts within the composed read scope", async () => {
      await controller.list(undefined);

      expect(getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.UpstreamAccount, Action.read);
      expect(list).toHaveBeenCalledWith(ME, { userId: ME, AND: [COND] });
    });

    // "My upstream accounts" has no meaning without a user, and must never
    // soften into an empty list.
    it('refuses an actor with no user behind it', async () => {
      getActingUserId.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(controller.list(undefined)).rejects.toThrow(ForbiddenException);
      expect(list).not.toHaveBeenCalled();
    });

    // An unlink must show on the next read.
    it('never opts into the response cache', () => {
      expect(Reflect.getMetadata(CACHE_RESPONSE_KEY, UpstreamAccountController.prototype.list)).toBeUndefined();
    });
  });

  describe('unlink', () => {
    it('unlinks the account at the upstream the key names, within the composed delete scope', async () => {
      await expect(controller.unlink('steam')).resolves.toEqual({
        message: t('success.upstream_account.unlinked', { upstream: Upstream.Steam }),
      });

      expect(getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.UpstreamAccount, Action.delete);
      expect(unlink).toHaveBeenCalledWith(ME, Upstream.Steam, { userId: ME, AND: [COND] });
    });

    it.each(['nope', 'Steam'])('refuses the key %p with UPSTREAM_UNKNOWN', async (key) => {
      const error = await controller.unlink(key).then(
        () => {
          throw new Error('expected a refusal');
        },
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(CodedHttpException);
      expect((error as CodedHttpException).getStatus()).toBe(Http.BadRequest);
      expect((error as CodedHttpException).code).toBe(UpstreamAccountErrorCode.UnknownUpstream);
      expect((error as CodedHttpException).code).toBe('UPSTREAM_UNKNOWN');
      expect(unlink).not.toHaveBeenCalled();
    });

    // The actor is checked before the key, so a userless actor learns nothing
    // about which keys exist (#935).
    it('refuses an actor with no user behind it with 403, whatever key it sends', async () => {
      getActingUserId.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(controller.unlink('nope')).rejects.toThrow(ForbiddenException);
      await expect(controller.unlink('steam')).rejects.toThrow(ForbiddenException);
      expect(unlink).not.toHaveBeenCalled();
    });
  });

  // The global auth guard only signs a requester in; without PoliciesGuard
  // CheckPolicies is never read, so any signed-in user would pass.
  it('puts PoliciesGuard on the class, so both routes carry it', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, UpstreamAccountController)).toEqual([PoliciesGuard]);
  });

  it.each([
    ['list', Action.read],
    ['unlink', Action.delete],
  ] as const)('%s lets only a holder of %s on UpstreamAccount through', (method, action) => {
    const handler = UpstreamAccountController.prototype[method];
    const policies = Reflect.getMetadata(CHECK_POLICIES_KEY, handler) as Array<(ability: AppAbility) => boolean>;
    const can = jest.fn();
    const ability = { can } as unknown as AppAbility;

    expect(policies).toHaveLength(1);

    // The policy's answer is the ability's, both ways, so a policy that asked
    // and ignored the answer would fail here.
    can.mockReturnValue(true);
    expect(policies[0](ability)).toBe(true);
    can.mockReturnValue(false);
    expect(policies[0](ability)).toBe(false);

    expect(can).toHaveBeenCalledTimes(2);
    expect(can).toHaveBeenNthCalledWith(1, action, ResourceType.UpstreamAccount);
    expect(can).toHaveBeenNthCalledWith(2, action, ResourceType.UpstreamAccount);
  });
});
