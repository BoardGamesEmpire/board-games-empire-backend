import { Action } from '@bge/database';
import { PERMISSION_ACTION_VERBS } from '@boardgamesempire/plugin-manifest';

/**
 * Drift spec: `PERMISSION_ACTION_VERBS` is maintained by hand in the
 * framework-free manifest lib (which cannot import the generated database
 * client); this spec keeps it in lockstep with the Prisma `Action` enum —
 * same pattern as the reserved-slug and category bijection specs. The verb
 * list is load-bearing: a bare declared slug's leading verb becomes the
 * CASL rule action for own-namespace grants, so drift here would either
 * reject valid manifests or admit verbs the ability factory cannot map.
 */
describe('PERMISSION_ACTION_VERBS ↔ Prisma Action', () => {
  it('mirrors the Action enum exactly — no more, no less', () => {
    expect(new Set<string>(PERMISSION_ACTION_VERBS)).toEqual(new Set<string>(Object.values(Action)));
  });
});
