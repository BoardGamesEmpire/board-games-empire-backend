import type { PermissionActionVerb } from './constants.js';
import { BARE_PLUGIN_PERMISSION_SLUG_PATTERN, PLUGIN_SLUG_PATTERN } from './constants.js';

/**
 * Canonical plugin-permission envelope: `plugin|<pluginSlug>|<bare>`.
 *
 * Single implementation, shared by the server and the #84 author CLI so the
 * two can never disagree about the at-rest form. Authors never write the
 * envelope — manifests carry BARE slugs (`<action>:<subject>[:...]`), and
 * expansion happens at validation/activation. `|` is the delimiter because
 * it splits mechanically with zero interaction with the interior colon
 * grammar, and no core permission slug can contain it — misrouting a plugin
 * slug as core (or vice versa) is structurally impossible.
 *
 * The middle segment is the plugin's `slug` (already `@unique` on `Plugin`),
 * so two plugins declaring the same bare slug expand to distinct canonical
 * forms. Publisher-scoped plugin identity is a registry concern deferred to
 * #84; if the plugin slug grammar ever grows a publisher prefix, it flows
 * through this helper without touching `PluginPermission`, grants, or the
 * ability factory.
 */
export const PLUGIN_PERMISSION_DELIMITER = '|' as const;

/** Leading segment of every canonical plugin-permission slug. */
export const PLUGIN_PERMISSION_ENVELOPE_PREFIX = `plugin${PLUGIN_PERMISSION_DELIMITER}` as const;

/** Structured view of a canonical `plugin|<pluginSlug>|<bare>` slug. */
export interface ParsedPluginPermissionSlug {
  /** The declaring plugin's slug — the collision-free namespace. */
  readonly pluginSlug: string;
  /** The author-written bare slug, e.g. `manage:digest`. */
  readonly bareSlug: string;
  /** Leading `Action` verb of the bare slug — the CASL rule action. */
  readonly action: PermissionActionVerb;
  /** Bare slug minus the verb, e.g. `storage:cloud` — the CASL rule subject path. */
  readonly subjectPath: string;
}

/** True when the slug carries the generated `plugin|` envelope. */
export const isPluginPermissionSlug = (slug: string): boolean => slug.startsWith(PLUGIN_PERMISSION_ENVELOPE_PREFIX);

/**
 * Expand a validated bare slug into its canonical form. Throws `RangeError`
 * on malformed inputs — callers hold validated values (manifest validation
 * gates both grammars), so a failure here is a programming error, not an
 * author error.
 */
export const expandPluginPermissionSlug = (pluginSlug: string, bareSlug: string): string => {
  if (!PLUGIN_SLUG_PATTERN.test(pluginSlug)) {
    throw new RangeError(`'${pluginSlug}' is not a valid plugin slug`);
  }

  if (!BARE_PLUGIN_PERMISSION_SLUG_PATTERN.test(bareSlug)) {
    throw new RangeError(`'${bareSlug}' is not a valid bare plugin permission slug (<action>:<subject>[:...])`);
  }

  return `${PLUGIN_PERMISSION_ENVELOPE_PREFIX}${pluginSlug}${PLUGIN_PERMISSION_DELIMITER}${bareSlug}`;
};

/**
 * Parse a canonical slug back into its parts. Throws `RangeError` on
 * anything that is not a well-formed envelope — grants and
 * `PluginPermission` rows carry only canonical forms at rest, so a parse
 * failure is corrupted state, and fail-loud beats a silent misroute.
 */
export const parsePluginPermissionSlug = (slug: string): ParsedPluginPermissionSlug => {
  const segments = slug.split(PLUGIN_PERMISSION_DELIMITER);

  if (segments.length !== 3 || segments[0] !== 'plugin') {
    throw new RangeError(`'${slug}' is not a canonical plugin permission slug (plugin|<pluginSlug>|<bare>)`);
  }

  const [, pluginSlug, bareSlug] = segments as [string, string, string];

  if (!PLUGIN_SLUG_PATTERN.test(pluginSlug)) {
    throw new RangeError(`'${slug}' carries an invalid plugin slug segment '${pluginSlug}'`);
  }

  if (!BARE_PLUGIN_PERMISSION_SLUG_PATTERN.test(bareSlug)) {
    throw new RangeError(`'${slug}' carries an invalid bare slug segment '${bareSlug}'`);
  }

  const separatorIndex = bareSlug.indexOf(':');

  return {
    pluginSlug,
    bareSlug,
    action: bareSlug.slice(0, separatorIndex) as PermissionActionVerb,
    subjectPath: bareSlug.slice(separatorIndex + 1),
  };
};

/**
 * CASL subject string for an own-namespace grant:
 * `plugin|<pluginSlug>|<subjectPath>` (the canonical envelope minus the
 * verb). This is the deterministic slug → `(action, subject)` mapping the
 * `PERMISSION_ACTION_VERBS` doc promises the ability factory (#60): the
 * parsed verb is the CASL action, this is the subject.
 *
 * Enveloped for the same reason the slug is: no core `ResourceType` subject
 * can contain `|`, so a plugin subject can never shadow a core one, and the
 * plugin-slug segment keeps two plugins' identical `subjectPath`s distinct.
 * Lives here (framework-free) so plugin authors and the #84 CLI can compute
 * the same subject their code will be checked against.
 */
export const pluginPermissionCaslSubject = (parsed: ParsedPluginPermissionSlug): string =>
  `${PLUGIN_PERMISSION_ENVELOPE_PREFIX}${parsed.pluginSlug}${PLUGIN_PERMISSION_DELIMITER}${parsed.subjectPath}`;
