/**
 * Typed failures for config-payload validation against a manifest's
 * `config.schema` (#320). Domain errors, not HTTP exceptions — the API
 * filter owns the status mapping, same discipline as the install, update,
 * and grant errors.
 *
 * The two classes deliberately split by who can act (the same contract as
 * `PluginUpdateManifestError.source`): a payload that violates the schema is
 * the caller's to fix, while a schema that cannot compile is stored-state
 * corruption the caller cannot touch.
 */

/** One schema violation in a submitted config payload. `path` is a JSON pointer into the payload, '' for the root. */
export interface PluginConfigIssue {
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
}

/** The submitted config payload violates the manifest's `config.schema` — a caller error, collect-all. */
export class PluginConfigValidationError extends Error {
  override readonly name = 'PluginConfigValidationError';

  constructor(
    public readonly slug: string,
    public readonly issues: readonly PluginConfigIssue[],
  ) {
    super(
      `Plugin '${slug}' config rejected: ${issues.length} schema violation(s) — ` +
        issues.map((issue) => `${issue.path === '' ? '<root>' : issue.path}: ${issue.message}`).join('; '),
    );
  }
}

/**
 * The manifest's `config.schema` itself cannot be compiled into a
 * validator. The schema passed manifest validation (which checks "is an
 * object", never interprets it), so this surfaces on first use — corrupted
 * or author-broken server state, never a payload problem.
 */
export class PluginConfigSchemaUnusableError extends Error {
  override readonly name = 'PluginConfigSchemaUnusableError';

  constructor(
    public readonly slug: string,
    public readonly version: string,
    detail: string,
  ) {
    super(
      `Plugin '${slug}'@${version} declares a config.schema that cannot be compiled: ${detail} — ` +
        'config writes are impossible until the plugin ships a usable schema',
    );
  }
}
