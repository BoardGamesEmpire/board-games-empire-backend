import type { Actor } from '@bge/actor-context';
import type { PluginActorView } from '@boardgamesempire/plugin-contract';

/**
 * Drift enforcement for the contract's structural actor view.
 *
 * `PluginActorView` mirrors the host `Actor` union without importing it —
 * the contract lib is buildable/publishable and must not reference the
 * private, source-only `@bge/actor-context`. This lib depends on both, so
 * the spec is where divergence becomes a compile error: the same pattern as
 * `permission-action-verbs.spec.ts` and `reserved-slugs.spec.ts`, for the
 * same reason (the lower lib cannot import the source of truth).
 *
 * Non-distributive `[A] extends [B]` so the whole union is checked as one,
 * not variant-by-variant against the whole.
 */
type Assignable<A, B> = [A] extends [B] ? true : false;

// The load-bearing checks are these assignments — a divergence is a type
// error here before any test runs.
const hostActorAssignableToView: Assignable<Actor, PluginActorView> = true;
const viewDeclaresNoUnknownKinds: Assignable<PluginActorView['kind'], Actor['kind']> = true;
const hostDeclaresNoUnviewableKinds: Assignable<Actor['kind'], PluginActorView['kind']> = true;

describe('PluginActorView (contract mirror of the @bge/actor-context Actor union)', () => {
  it('every host Actor variant is assignable to the contract view', () => {
    expect(hostActorAssignableToView).toBe(true);
  });

  it('the view declares no actor kind the host union lacks', () => {
    expect(viewDeclaresNoUnknownKinds).toBe(true);
  });

  it('the host declares no actor kind the view cannot represent', () => {
    expect(hostDeclaresNoUnviewableKinds).toBe(true);
  });
});
