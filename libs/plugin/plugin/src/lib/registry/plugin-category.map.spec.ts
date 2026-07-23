import { PluginCategory } from '@bge/database';
import { PLUGIN_CATEGORIES } from '@boardgamesempire/plugin-manifest';
import { MANIFEST_CATEGORY_TO_PRISMA, PRISMA_CATEGORY_TO_MANIFEST } from './plugin-category.map.js';

describe('MANIFEST_CATEGORY_TO_PRISMA', () => {
  it('maps every manifest category (total over PLUGIN_CATEGORIES)', () => {
    expect(Object.keys(MANIFEST_CATEGORY_TO_PRISMA).sort()).toEqual([...PLUGIN_CATEGORIES].sort());
  });

  it('is a bijection onto the Prisma PluginCategory enum — none unmapped, none reused', () => {
    const mapped = Object.values(MANIFEST_CATEGORY_TO_PRISMA);
    const enumValues = Object.values(PluginCategory);

    expect([...mapped].sort()).toEqual([...enumValues].sort());
    expect(new Set(mapped).size).toBe(mapped.length);
  });

  it('has the same cardinality on both surfaces (guards a silent add to one side)', () => {
    expect(PLUGIN_CATEGORIES).toHaveLength(Object.values(PluginCategory).length);
  });

  it('round-trips manifest → prisma → manifest for every category', () => {
    for (const category of PLUGIN_CATEGORIES) {
      expect(PRISMA_CATEGORY_TO_MANIFEST[MANIFEST_CATEGORY_TO_PRISMA[category]]).toBe(category);
    }
  });
});
