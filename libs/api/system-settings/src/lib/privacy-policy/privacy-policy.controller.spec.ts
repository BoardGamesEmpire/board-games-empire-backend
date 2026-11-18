import { Action, ResourceType } from '@bge/database';
import type { AppAbility } from '@bge/permissions';
import { CHECK_POLICIES_KEY, PoliciesGuard } from '@bge/permissions';
import { CACHE_RESPONSE_KEY } from '@bge/shared';
import { createTestingModuleWithDb } from '@bge/testing';
import { HttpStatus } from '@nestjs/common';
import { GUARDS_METADATA, HEADERS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import type { Response } from 'express';
import type { PrivacyPolicyDto } from './dto/privacy-policy.dto';
import { PrivacyPolicyController } from './privacy-policy.controller';
import { PrivacyPolicyService } from './privacy-policy.service';

/**
 * The key better-auth's decorator writes, read off the decorator rather than
 * restated: the package does not export it, and it is the key the auth guard
 * admits an unauthenticated request by.
 */
const ALLOW_ANONYMOUS_KEY = AllowAnonymous().KEY;

const policy: PrivacyPolicyDto = {
  availableLanguages: ['de', 'en'],
  language: 'de',
  markdown: '# Datenschutz\n',
  source: 'operator',
  updatedAt: '2026-12-01T10:20:30.000Z',
};

describe('PrivacyPolicyController (#934)', () => {
  let controller: PrivacyPolicyController;
  const read = jest.fn();
  const put = jest.fn();
  const remove = jest.fn();

  beforeEach(async () => {
    read.mockReset().mockResolvedValue(policy);
    put.mockReset().mockResolvedValue(policy);
    remove.mockReset().mockResolvedValue(undefined);
    const { module } = await createTestingModuleWithDb({
      controllers: [PrivacyPolicyController],
      providers: [{ provide: PrivacyPolicyService, useValue: { put, read, remove } }],
      overrideGuards: [PoliciesGuard],
    });

    controller = module.get(PrivacyPolicyController);
  });

  // On the read alone, so any other route on this controller needs sign-in.
  it('needs no sign-in', () => {
    expect(Reflect.getMetadata(ALLOW_ANONYMOUS_KEY, PrivacyPolicyController.prototype.read)).toBe(true);
    expect(Reflect.getMetadata(ALLOW_ANONYMOUS_KEY, PrivacyPolicyController)).toBeUndefined();
  });

  it('sets Content-Language to the language served, and Cache-Control: no-cache', async () => {
    const setHeader = jest.fn();
    const vary = jest.fn();

    await expect(
      controller.read({ lang: 'de' }, 'fr-CH, fr;q=0.9', { setHeader, vary } as unknown as Response),
    ).resolves.toEqual({ privacyPolicy: policy });

    expect(read).toHaveBeenCalledWith({ acceptLanguage: 'fr-CH, fr;q=0.9', lang: 'de' });
    expect(setHeader).toHaveBeenCalledWith('Content-Language', 'de');
    expect(vary).toHaveBeenCalledWith('Accept-Language');
    expect(Reflect.getMetadata(HEADERS_METADATA, PrivacyPolicyController.prototype.read)).toContainEqual({
      name: 'Cache-Control',
      value: 'no-cache',
    });
  });

  // A server admin re-reads the policy after an edit, and a cached read would
  // show the text from before it for the whole TTL (#530).
  it('never opts into the response cache', () => {
    expect(Reflect.getMetadata(CACHE_RESPONSE_KEY, PrivacyPolicyController.prototype.read)).toBeUndefined();
  });

  it('replaces the policy in a language and answers it as { privacyPolicy }', async () => {
    await expect(controller.replace('de', { markdown: '# Datenschutz\n' })).resolves.toEqual({
      privacyPolicy: policy,
    });

    expect(put).toHaveBeenCalledWith('de', '# Datenschutz\n');
  });

  it('removes the policy in a language and answers 204', async () => {
    await expect(controller.remove('de')).resolves.toBeUndefined();

    expect(remove).toHaveBeenCalledWith('de');
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, PrivacyPolicyController.prototype.remove)).toBe(
      HttpStatus.NO_CONTENT,
    );
  });

  // The class carries no guard, so the read stays open to anyone. Each write
  // binds PoliciesGuard itself: the global auth guard only signs a caller in,
  // and without the guard CheckPolicies is never read, so any signed-in user
  // would pass.
  it.each(['replace', 'remove'] as const)(
    '%s lets only a holder of manage on PrivacyPolicy through, behind PoliciesGuard',
    (method) => {
      const handler = PrivacyPolicyController.prototype[method];
      const policies = Reflect.getMetadata(CHECK_POLICIES_KEY, handler) as Array<(ability: AppAbility) => boolean>;
      const can = jest.fn();
      const ability = { can } as unknown as AppAbility;

      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([PoliciesGuard]);
      expect(policies).toHaveLength(1);

      // The policy's answer is the ability's, both ways, so a policy that asked
      // and ignored the answer would fail here.
      can.mockReturnValue(true);
      expect(policies[0](ability)).toBe(true);
      can.mockReturnValue(false);
      expect(policies[0](ability)).toBe(false);

      expect(can).toHaveBeenCalledTimes(2);
      expect(can).toHaveBeenNthCalledWith(1, Action.manage, ResourceType.PrivacyPolicy);
      expect(can).toHaveBeenNthCalledWith(2, Action.manage, ResourceType.PrivacyPolicy);
    },
  );

  it('asks no permission of the read, and puts no guard on the class', () => {
    expect(Reflect.getMetadata(CHECK_POLICIES_KEY, PrivacyPolicyController.prototype.read)).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, PrivacyPolicyController.prototype.read)).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, PrivacyPolicyController)).toBeUndefined();
  });
});
