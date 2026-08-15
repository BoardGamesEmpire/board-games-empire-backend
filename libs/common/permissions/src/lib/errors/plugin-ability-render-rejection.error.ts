import type { PluginUnit } from '@bge/actor-context';

/**
 * Why a granted permission was refused at plugin ability resolution:
 *
 * - `out-of-context-variable` — a core permission's condition template
 *   references a variable outside the D-U unit-coordinate context (e.g. the
 *   user-centric `{{ user.id }}` seeds, or `{{ unit.householdId }}` while
 *   operating as a Server unit). Mustache renders missing variables to `''`,
 *   which would produce a malformed, potentially over-broad clause like
 *   `{ userId: '' }` — so the rule is rejected, never rendered (D-U).
 * - `malformed-template` — the condition template does not even parse
 *   (unclosed tag, broken delimiter change). Nothing can be validated about
 *   it, so nothing renders.
 * - `foreign-namespace-slug` — an own-namespace grant row whose canonical
 *   slug names a DIFFERENT plugin's namespace. Grants are keyed by pluginId,
 *   so this is corrupted state; rendering it would hand this plugin another
 *   plugin's subject space.
 * - `malformed-slug` — a grant row whose slug carries the `plugin|` envelope
 *   prefix but is not a parseable canonical slug. Same corruption class:
 *   only canonical forms exist at rest.
 */
export type PluginAbilityRejectionReason =
  | 'out-of-context-variable'
  | 'malformed-template'
  | 'foreign-namespace-slug'
  | 'malformed-slug';

const REASON_DETAIL: Readonly<Record<PluginAbilityRejectionReason, (input: { variable?: string }) => string>> = {
  'out-of-context-variable': ({ variable }) =>
    `condition template references '${variable}', which is outside the unit-coordinate context`,
  'malformed-template': () => 'condition template does not parse',
  'foreign-namespace-slug': () => 'canonical slug names a different plugin’s namespace',
  'malformed-slug': () => 'slug carries the plugin| envelope but is not a parseable canonical form',
};

/**
 * The D60-3 typed rejection: raised when a granted permission cannot be
 * consumed safely — by `AbilityFactory.createForPlugin` (template rejection)
 * or by `PermissionsService.getPluginGrantSnapshot` (grant-table
 * corruption) — carrying everything the single logging site in
 * `AbilityService` needs to make the resulting 403 debuggable (plugin,
 * permission, offending variable, unit coordinates).
 *
 * Deliberately a plain `Error`, not an `HttpException`: the 403 mapping is
 * the handling site's job, and resolution also runs outside HTTP (queue
 * workers, where it becomes `UnrecoverableError`).
 *
 * Distinct from the quiet empty-ability path (unit not served): rejection
 * means a MISCONFIGURED grant that someone must fix; empty means a unit
 * that simply is not being served. Do not conflate the two.
 */
export class PluginAbilityRenderRejectionError extends Error {
  override readonly name = 'PluginAbilityRenderRejectionError';

  readonly reason: PluginAbilityRejectionReason;
  readonly pluginId: string;
  readonly pluginSlug: string;
  readonly permissionSlug: string;
  /** The offending template variable for `out-of-context-variable`; absent otherwise. */
  readonly variable?: string;
  readonly unit: PluginUnit;

  constructor(input: {
    reason: PluginAbilityRejectionReason;
    pluginId: string;
    pluginSlug: string;
    permissionSlug: string;
    variable?: string;
    unit: PluginUnit;
  }) {
    super(
      `Cannot render granted permission '${input.permissionSlug}' for plugin '${input.pluginSlug}': ` +
        REASON_DETAIL[input.reason](input),
    );

    this.reason = input.reason;
    this.pluginId = input.pluginId;
    this.pluginSlug = input.pluginSlug;
    this.permissionSlug = input.permissionSlug;
    this.variable = input.variable;
    this.unit = input.unit;
  }
}
