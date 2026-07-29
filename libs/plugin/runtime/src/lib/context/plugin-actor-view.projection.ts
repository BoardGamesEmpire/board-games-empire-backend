import type { Actor } from '@bge/actor-context';
import type { PluginActorView } from '@boardgamesempire/plugin-contract';
import { UnknownActorKindError } from './context.errors';

/**
 * Projects the host CLS actor onto the contract's structural view before it
 * crosses into plugin code (#216).
 *
 * Type-level assignability (`plugin-actor-view.spec.ts`) is necessary but
 * NOT sufficient: handing back `getActor()` directly would pass the compiler
 * while giving plugins the live CLS object, which breaks both guarantees the
 * contract documents.
 *
 * - Fields the host adds to a variant would be readable off the object
 *   (`Object.keys`, `JSON.stringify`, index access) even though the view
 *   never declared them — and the drift spec passes for additive changes by
 *   design, so nothing would catch it. Copying field-by-field makes
 *   "not in the view means not visible" true at runtime.
 * - `readonly` is erased at runtime, and `getActor()` returns the object CLS
 *   holds. A plugin mutating it would corrupt host audit attribution and
 *   ability construction for the remainder of the request. Every level is a
 *   frozen copy, so writes fail (strict mode) or no-op — never propagate.
 *
 * The `switch` is exhaustive: a new `Actor` variant fails to compile here
 * rather than silently falling through to the throw. Worker mode (#197) must
 * apply the same projection host-side before serialization, which is why
 * this is exported.
 */
export const toPluginActorView = (actor: Actor | null): PluginActorView | null =>
  actor === null ? null : projectActor(actor);

const projectActor = (actor: Actor): PluginActorView => {
  switch (actor.kind) {
    case 'user':
      return Object.freeze({ kind: actor.kind, userId: actor.userId });
    case 'anonymous':
      return Object.freeze({ kind: actor.kind, userId: actor.userId });
    case 'apiKey':
      return Object.freeze({ kind: actor.kind, apiKeyId: actor.apiKeyId, userId: actor.userId });
    case 'system':
      return Object.freeze({ kind: actor.kind, reason: actor.reason });
    case 'external':
      return Object.freeze({ kind: actor.kind, system: actor.system, identifier: actor.identifier });
    case 'plugin':
      // Recursive: the trigger chain is projected level by level, so a
      // plugin walking `trigger` never reaches a host-owned object.
      return Object.freeze({ kind: actor.kind, pluginId: actor.pluginId, trigger: projectActor(actor.trigger) });
    default: {
      const unprojectable: never = actor;

      throw new UnknownActorKindError((unprojectable as { readonly kind?: unknown }).kind);
    }
  }
};
