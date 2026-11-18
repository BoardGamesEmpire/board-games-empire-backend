import type { RiskLevel } from '@bge/database';
import type { ConsentUngrantableCause } from '../grants/consent-grantability';

/**
 * Typed refusals of a consent act (#1150). Domain errors, not HTTP
 * exceptions: the API filter owns the status mapping. Each `name` is a
 * string literal, hand-pinned so minification cannot change the wire code
 * derived from it.
 */

export interface ConsentActStaleRisk {
  readonly currentRiskLevel: RiskLevel;
  readonly permissionSlug: string;
  /** Null when an install or approval named no risk for a permission it would grant (#1336). */
  readonly shownRiskLevel: RiskLevel | null;
}

/**
 * The consent surface the unit answered is no longer current: the sha it
 * named is neither sha the act may name (`kind: 'manifest'`), or a risk it
 * showed differs from today's (`kind: 'risk'`). Reading the consent surface
 * again cures it. The filter answers 409.
 *
 * The discriminator is `kind`, not `cause`: `Error.cause` is a standard slot
 * that loggers walk as the underlying error.
 */
export class PluginConsentActStaleError extends Error {
  override readonly name = 'PluginConsentActStaleError';

  constructor(
    public readonly pluginSlug: string,
    public readonly kind: 'manifest' | 'risk',
    public readonly staleRisks: readonly ConsentActStaleRisk[] = [],
  ) {
    super(
      kind === 'manifest'
        ? `The consent surface for plugin '${pluginSlug}' has changed since it was shown; review it again`
        : `The risk of ${staleRisks.length} permission(s) of plugin '${pluginSlug}' has changed since it was shown; review it again`,
    );
  }
}

/**
 * A switch-on did not grant exactly the required set at the unit's scope:
 * `missingSlugs` were left out, `refusedSlugs` were answered `Denied`. The
 * filter answers 422.
 */
export class PluginConsentActRequiredSetError extends Error {
  override readonly name = 'PluginConsentActRequiredSetError';

  constructor(
    public readonly pluginSlug: string,
    public readonly missingSlugs: readonly string[],
    public readonly refusedSlugs: readonly string[],
  ) {
    super(`Switching on plugin '${pluginSlug}' needs every required permission granted`);
  }
}

export type ConsentActAnswerRule =
  | 'duplicate'
  | 'not-requested'
  | 'toggle-required'
  | 'not-outstanding'
  | 'staged-kind'
  | 'staged-refusal'
  | 'staged-not-new'
  /** A server review may only accept. */
  | 'server-refusal'
  /** A toggle without exactly one answer, or a review with none. */
  | 'answer-count';

/** An answer breaks `rule`; `permissionSlugs` lists every permission that breaks it. The filter answers 422. */
export class PluginConsentActAnswerError extends Error {
  override readonly name = 'PluginConsentActAnswerError';

  constructor(
    public readonly pluginSlug: string,
    public readonly rule: ConsentActAnswerRule,
    public readonly permissionSlugs: readonly string[],
  ) {
    super(`The answers for plugin '${pluginSlug}' break the rule '${rule}'`);
  }
}

export interface ConsentActUngrantablePermission {
  readonly cause: ConsentUngrantableCause;
  readonly permissionSlug: string;
}

/**
 * A required permission of a switch-on (answered or left out), or any permission answered
 * `Granted`, can never be granted at the scope that decides it, or has no
 * risk a consent surface could show. Reading the surface again would not cure
 * it, so it is never the stale refusal. The filter answers 409.
 */
export class PluginConsentActUngrantableError extends Error {
  override readonly name = 'PluginConsentActUngrantableError';

  constructor(
    public readonly pluginSlug: string,
    public readonly permissions: readonly ConsentActUngrantablePermission[],
  ) {
    super(`Plugin '${pluginSlug}' asks for ${permissions.length} permission(s) that cannot be granted here`);
  }
}

/**
 * A user switch-on of a plugin whose active manifest requests nothing at user
 * scope. A user's switch-on accepts the plugin's user-scope requests, so with
 * none there is nothing for it to accept, and the unit enablement it would
 * create confers nothing. Refusing it keeps a user unit enablement to the
 * plugins that ask something of a user (#381, #1150). Reading the surface again
 * would not cure it, so it is not the stale refusal. The filter answers 422.
 */
export class PluginConsentActNoUserScopeError extends Error {
  override readonly name = 'PluginConsentActNoUserScopeError';

  constructor(public readonly pluginSlug: string) {
    super(`Plugin '${pluginSlug}' requests nothing at user scope, so a user has nothing to switch on`);
  }
}

/**
 * A write that stores a presentation (a consent act, an install or an update
 * approval) named a locale this server does not support (#1301). The write
 * would otherwise record text in a language nobody was shown, so it is
 * refused before anything is read or written. The filter answers 422.
 */
export class PluginConsentActLocaleError extends Error {
  override readonly name = 'PluginConsentActLocaleError';

  constructor(public readonly locale: string) {
    super(`'${locale}' is not a locale this server supports`);
  }
}

/**
 * A toggle or review addressed a unit with no unit enablement, or one whose
 * switch is off. Thrown by the consent act service, not the planner. The
 * filter answers 409.
 */
export class PluginConsentActUnitOffError extends Error {
  override readonly name = 'PluginConsentActUnitOffError';

  constructor(
    public readonly pluginSlug: string,
    public readonly scopeType: 'Household' | 'User',
  ) {
    super(`Plugin '${pluginSlug}' is not switched on for this ${scopeType.toLowerCase()}`);
  }
}
