import * as proto from '@board-games-empire/proto-gateway';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ReleaseGraphResolver } from './release-graph.resolver';

describe('ReleaseGraphResolver', () => {
  let resolver: ReleaseGraphResolver;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [ReleaseGraphResolver],
    }).compile();

    resolver = module.get(ReleaseGraphResolver);
  });

  function makeRelease(overrides: Partial<proto.GameReleaseData>): proto.GameReleaseData {
    return {
      externalId: 'rel-1',
      platform: {
        externalId: 'p',
        name: 'P',
        platformType: proto.PlatformType.PLATFORM_TYPE_TABLETOP,
      },
      status: proto.ReleaseStatus.RELEASE_STATUS_RELEASED,
      localizations: [],
      languages: [],
      ...overrides,
    } as proto.GameReleaseData;
  }

  describe('parent resolution', () => {
    it('builds parent map for in-batch references', () => {
      const parentMap = resolver.preResolve([
        makeRelease({ externalId: 'parent' }),
        makeRelease({ externalId: 'child-a', parentEditionExternalId: 'parent' }),
        makeRelease({ externalId: 'child-b', parentEditionExternalId: 'parent' }),
      ]);

      expect(parentMap.size).toBe(2);
      expect(parentMap.get('child-a')).toBe('parent');
      expect(parentMap.get('child-b')).toBe('parent');
    });

    it('drops references to parents not in the batch', () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      const parentMap = resolver.preResolve([
        makeRelease({ externalId: 'orphan', parentEditionExternalId: 'missing-parent' }),
      ]);

      expect(parentMap.size).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing-parent'));
    });

    it('drops self-references', () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      const parentMap = resolver.preResolve([makeRelease({ externalId: 'self', parentEditionExternalId: 'self' })]);

      expect(parentMap.size).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('references itself'));
    });

    it('skips releases without parent_edition_external_id', () => {
      const parentMap = resolver.preResolve([
        makeRelease({ externalId: 'a' }),
        makeRelease({ externalId: 'b', parentEditionExternalId: undefined }),
      ]);

      expect(parentMap.size).toBe(0);
    });
  });
});
