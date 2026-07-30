import { PluginExecutionMode, PluginScope } from '@bge/database';
import { PLUGIN_EXECUTION_MODES, PLUGIN_SCOPES } from '@boardgamesempire/plugin-manifest';
import { MANIFEST_EXECUTION_MODE_TO_PRISMA, MANIFEST_SCOPE_TO_PRISMA } from './manifest-enum.maps';

describe('manifest ↔ Prisma enum bridges', () => {
  describe('MANIFEST_SCOPE_TO_PRISMA', () => {
    it('covers every manifest scope exactly once', () => {
      expect(Object.keys(MANIFEST_SCOPE_TO_PRISMA).sort()).toEqual([...PLUGIN_SCOPES].sort());
    });

    it('covers every Prisma PluginScope value exactly once (injective and surjective)', () => {
      expect(Object.values(MANIFEST_SCOPE_TO_PRISMA).sort()).toEqual(Object.values(PluginScope).sort());
    });
  });

  describe('MANIFEST_EXECUTION_MODE_TO_PRISMA', () => {
    it('covers every manifest execution mode exactly once', () => {
      expect(Object.keys(MANIFEST_EXECUTION_MODE_TO_PRISMA).sort()).toEqual([...PLUGIN_EXECUTION_MODES].sort());
    });

    it('covers every Prisma PluginExecutionMode value exactly once (injective and surjective)', () => {
      expect(Object.values(MANIFEST_EXECUTION_MODE_TO_PRISMA).sort()).toEqual(
        Object.values(PluginExecutionMode).sort(),
      );
    });
  });
});
