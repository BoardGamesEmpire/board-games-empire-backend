import type { PluginUnit } from '@bge/actor-context';
import type { Permission } from '@bge/database';

/**
 * Everything `AbilityFactory.createForPlugin` needs, resolved by
 * `PermissionsService.getPluginGrantSnapshot` (#60): the plugin's
 * identity coordinates for the condition-template render context, whether
 * the operating unit is currently served at all, and the granted set split by
 * origin (core catalog rows vs. own-namespace canonical slugs).
 *
 * The read path has already applied both consumption guards when this
 * shape exists: `Denied`/absent grants never appear, grants whose
 * `decidedRiskLevel` no longer covers the permission's current risk are
 * excluded (`riskCovers`, the C3 "a Granted row is not consent" invariant),
 * and `servable: false` means the factory must produce a no-rule ability
 * regardless of what was granted.
 */
export interface PluginGrantSnapshot {
  readonly plugin: {
    readonly id: string;
    readonly slug: string;
  };
  readonly unit: PluginUnit;
  /**
   * The serving predicate at resolution time: the plugin is enabled and not
   * tombstoned, AND the unit's enablement row (Household/User scopes) exists
   * with `enabled && !suspendedForConsent`. Server units need only the
   * plugin-level half.
   */
  readonly servable: boolean;
  /** Core `Permission` rows whose grants survived the guards, in full (conditions/fields/inverted). */
  readonly corePermissions: Permission[];
  /** Canonical `plugin|<slug>|<bare>` slugs of surviving own-namespace grants. */
  readonly ownGrantSlugs: string[];
}
