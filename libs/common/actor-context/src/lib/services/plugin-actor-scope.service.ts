import { Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { type Actor, assertPluginUnit, clonePluginUnit, type PluginActor, type PluginUnit } from '../types';
import { AuditContextInternalService } from './audit-context-internal.service';
import { AuditContextService } from './audit-context.service';

/**
 * Sanctioned API for entering a CLS scope as a PLUGIN principal (#59).
 * Counterpart to `SystemActorScope`: where that mints `system` actors for
 * host-initiated work, this mints `plugin` actors for code executing inside
 * a loaded plugin — the "CLS plugin-actor entry" the actor union anticipated
 * ("no populator until plugin loader exists").
 *
 * The minted actor is `{ kind: 'plugin', pluginId, trigger }` where
 * `trigger` is the actor ALREADY in CLS at call time — a user hitting an
 * endpoint that fans into a plugin keeps their attribution as the trigger,
 * satisfying "plugin code executing on behalf of a `trigger` actor". When no
 * actor is in scope (boot-time factory invocation), the trigger is a
 * `system` actor with the caller-supplied reason, so the chain is never
 * anonymous.
 *
 * Security: callers choose only the `pluginId` and a system fallback reason.
 * The trigger comes from CLS, never from caller input, so this cannot be
 * used to forge `user`/`apiKey` attribution — the same containment argument
 * as `SystemActorScope`. Nested calls produce nested plugin actors;
 * `resolveTrigger` walks the chain back to the originating principal.
 *
 * Correlation: an inherited correlation id is PRESERVED (the plugin step is
 * part of the same causal chain); a fresh one is minted only when entering
 * from an empty scope. Source is likewise inherited, defaulting to
 * `'system'` for boot-time entry.
 */
@Injectable()
export class PluginActorScope {
  constructor(
    private readonly internal: AuditContextInternalService,
    private readonly reader: AuditContextService,
  ) {}

  /**
   * Enters a CLS scope with a `plugin` actor and runs `fn` inside it.
   * Synchronous when `fn` is synchronous; CLS propagates through promise
   * chains via AsyncLocalStorage when `fn` is async.
   *
   * `unit` is the consent unit the plugin operates AS for the duration of
   * the scope (#60 D60-1) — deliberately required, never defaulted: this is
   * an authority input (grants and CASL condition templates resolve against
   * it), and an implicit Server default would silently widen or narrow what
   * a forgotten call site resolves. Boot-time loads pass
   * `SERVER_PLUGIN_UNIT`. A unit violating the coordinate rules throws
   * before any scope is entered. The stored actor carries a detached copy,
   * so caller-side mutation of the passed object cannot retarget the scope.
   *
   * `systemFallbackReason` names the host task when there is no actor in
   * scope to inherit (e.g. `'plugin-boot-load'`); it is ignored whenever a
   * real trigger exists.
   */
  run<T>(pluginId: string, unit: PluginUnit, systemFallbackReason: string, fn: () => T): T {
    assertPluginUnit(unit, `Plugin actor scope for '${pluginId}'`);

    const trigger: Actor = this.reader.getActor() ?? { kind: 'system', reason: systemFallbackReason };
    const actor: PluginActor = { kind: 'plugin', pluginId, unit: clonePluginUnit(unit), trigger };

    return this.internal.runWith(
      {
        actor,
        correlationId: this.reader.getCorrelationId() ?? crypto.randomUUID(),
        source: this.reader.getSource() ?? 'system',
      },
      fn,
    );
  }
}
