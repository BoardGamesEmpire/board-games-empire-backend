import { CACHE_RESPONSE_KEY } from '@bge/shared';
import { createTestingModuleWithDb } from '@bge/testing';
import { HEADERS_METADATA } from '@nestjs/common/constants';
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

  beforeEach(async () => {
    read.mockReset().mockResolvedValue(policy);
    const { module } = await createTestingModuleWithDb({
      controllers: [PrivacyPolicyController],
      providers: [{ provide: PrivacyPolicyService, useValue: { read } }],
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
});
