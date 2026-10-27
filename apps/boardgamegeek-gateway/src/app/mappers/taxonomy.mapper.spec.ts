import type * as proto from '@boardgamesempire/proto-gateway';
import { toCategoryList, toMechanicList } from './taxonomy.mapper';
import { ENTITY_RUN } from './testing/entity-runs';

interface TaxonomyListCase {
  name: string;
  list: () => Array<proto.CategoryData | proto.MechanicData>;
  count: number;
  noun: string;
  pinned: Array<proto.CategoryData | proto.MechanicData>;
}

describe.each<TaxonomyListCase>([
  {
    name: 'toCategoryList',
    list: toCategoryList,
    count: 85,
    noun: 'categories',
    pinned: [
      { externalId: '1009', name: 'Abstract Strategy' },
      { externalId: '1041', name: "Children's Game" },
      { externalId: '1120', name: 'Print & Play' },
    ],
  },
  {
    name: 'toMechanicList',
    list: toMechanicList,
    count: 200,
    noun: 'mechanics',
    pinned: [
      { externalId: '2082', name: 'Worker Placement' },
      { externalId: '2858', name: "Prisoner's Dilemma" },
      { externalId: '3144', name: 'Lane Battler' },
    ],
  },
])('$name (#839)', ({ list, count, noun, pinned }) => {
  it(`lists all ${count} of BGG’s ${noun}`, () => {
    expect(list()).toHaveLength(count);
  });

  it('gives each entry a unique id made of digits, the external ID a fetched game carries', () => {
    const ids = list().map((entry) => entry.externalId);

    expect(ids.filter((id) => !/^\d+$/.test(id))).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives each entry a trimmed, decoded name', () => {
    const names = list().map((entry) => entry.name);

    expect(names.filter((name) => name.length === 0 || name !== name.trim() || ENTITY_RUN.test(name))).toEqual([]);
  });

  it('carries the entries BGG names on its browse page', () => {
    expect(list()).toEqual(expect.arrayContaining(pinned));
  });

  it('returns a fresh list each call', () => {
    const first = list();
    const original = { ...first[0] };

    first.push({ externalId: '0', name: 'Added by a caller' });
    first[0].name = 'Renamed by a caller';

    expect(list()).toHaveLength(count);
    expect(list()[0]).toEqual(original);
  });
});
