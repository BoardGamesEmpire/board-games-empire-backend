import { PluginUnitDormantReason } from '@bge/database';

/**
 * The five stable codes a client receives for a plugin's state at one
 * consent unit (#1149). Each is worked out when read, never stored, so a
 * client can announce or rephrase it without parsing text.
 */
export const PLUGIN_UNIT_STATE_CODES = ['off', 'on', 'review_pending', 'needs_configuration', 'unavailable'] as const;

export type PluginUnitStateCode = (typeof PLUGIN_UNIT_STATE_CODES)[number];

/**
 * Precedence, strongest first: a unit with no unit enablement or with its
 * switch off is `off`, whatever else holds, because nothing would run even if
 * the rest were cured. `unavailable` comes next: the server switch is off,
 * the stored manifest cannot be read, or the plugin's scope no longer admits
 * the unit. Either way only a server admin can bring the unit back, and a
 * code that said `on` while nothing runs would mislead a client that
 * announces the code alone (the glossary's Server switch: nothing runs for
 * anyone while it is off; the ability path refuses an unreadable manifest,
 * PR #1155 review). A non-conforming configuration (`needs_configuration`)
 * follows, cured by supplying one;
 * neither is hidden behind consent the unit could give and still not be
 * served. Outstanding required permissions read `review_pending`; only then
 * `on`.
 *
 * `outstandingCount` counts required permissions only — a refused optional
 * permission switches its feature off but never holds the unit in review
 * (#1149).
 */
export function derivePluginUnitState(input: {
  readonly anchored: boolean;
  readonly enabled: boolean;
  /** The plugin's server switch, under which the unit's own switch sits. */
  readonly serverEnabled: boolean;
  /**
   * The stored manifest failed re-validation (the inventory's
   * `manifestUnreadable` marker), so the plugin cannot be served for anyone.
   */
  readonly manifestUnreadable: boolean;
  readonly dormantReason: PluginUnitDormantReason | null;
  readonly outstandingCount: number;
}): PluginUnitStateCode {
  if (!input.anchored || !input.enabled) {
    return 'off';
  }

  if (
    !input.serverEnabled ||
    input.manifestUnreadable ||
    input.dormantReason === PluginUnitDormantReason.ScopeOrphaned
  ) {
    return 'unavailable';
  }

  if (input.dormantReason === PluginUnitDormantReason.NeedsConfiguration) {
    return 'needs_configuration';
  }

  return input.outstandingCount > 0 ? 'review_pending' : 'on';
}
