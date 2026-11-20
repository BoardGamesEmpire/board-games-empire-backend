import type { PluginUnitDormancy } from '@bge/database';

/**
 * The five stable codes a client receives for a plugin's state at one
 * consent unit (#1149). Each is worked out when read, never stored, so a
 * client can announce or rephrase it without parsing text.
 */
export const PLUGIN_UNIT_STATE_CODES = ['off', 'on', 'review_pending', 'needs_configuration', 'unavailable'] as const;

export type PluginUnitStateCode = (typeof PLUGIN_UNIT_STATE_CODES)[number];

/**
 * The state code a dormancy reads as: the same word (#1151). The dormancy
 * codes live in `@bge/database`, which cannot import the runtime, so this
 * mapping is typed to fail to compile when a dormancy code is not also a
 * state code: each value must be its own key and a state code at once.
 */
const STATE_OF_DORMANCY: { readonly [D in PluginUnitDormancy]: D & PluginUnitStateCode } = {
  unavailable: 'unavailable',
  needs_configuration: 'needs_configuration',
};

/**
 * Precedence, strongest first: a unit with no unit enablement or with its
 * switch off is `off`, whatever else holds, because nothing would run even if
 * the rest were cured. `unavailable` comes next: the server switch is off, or
 * the unit's dormancy is `unavailable` (the stored manifest cannot be read,
 * the manifest has no surface at the unit's scope, or its config schema
 * cannot be used). Either way only a server admin can bring the unit back,
 * and a code that said `on` while nothing runs would mislead a client that
 * announces the code alone (the glossary's Server switch: nothing runs for
 * anyone while it is off; the ability path refuses an unreadable manifest,
 * PR #1155 review). A dormancy of `needs_configuration` follows, cured by
 * supplying a conforming document; neither is hidden behind consent the unit
 * could give and still not be served. Outstanding required permissions read
 * `review_pending`; only then `on`.
 *
 * `outstandingCount` counts required permissions only — a refused optional
 * permission switches its feature off but never holds the unit in review
 * (#1149).
 */
export function derivePluginUnitState(input: {
  readonly anchored: boolean;

  /** What `derivePluginUnitDormancy` worked out for the unit on this read (#1151). */
  readonly dormancy: PluginUnitDormancy | null;

  readonly enabled: boolean;
  readonly outstandingCount: number;

  /** The plugin's server switch, under which the unit's own switch sits. */
  readonly serverEnabled: boolean;
}): PluginUnitStateCode {
  if (!input.anchored || !input.enabled) {
    return 'off';
  }

  if (!input.serverEnabled) {
    return 'unavailable';
  }

  if (input.dormancy !== null) {
    return STATE_OF_DORMANCY[input.dormancy];
  }

  return input.outstandingCount > 0 ? 'review_pending' : 'on';
}
