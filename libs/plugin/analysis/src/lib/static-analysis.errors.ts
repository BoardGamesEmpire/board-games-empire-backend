/**
 * The resolved meriyah build failed one or more parser capability probes
 * (#219), so the AST pass would degrade: every file using syntax the
 * build cannot parse records `parse-failure` instead of being walked, its
 * `require()` calls go unscreened, and the lexer-failure fallback is gone
 * for it. Whatever screening survives, a gate running at partial coverage
 * while its report reads as complete is the one outcome static analysis
 * must never produce — so the analyzer refuses to run instead of proceeding
 * on a log line. Known cause: a stale meriyah major shadowing the pinned
 * one — 1.x honours the legacy `module` option key and parses a bare
 * import, which is why the probe exercises the modern syntax classes real
 * plugin code uses rather than module parsing alone.
 *
 * Lives with the analyzer, not the installer's errors, so the server and a
 * plugin author's tools raise one class (#1093); the server's exception
 * filter matches it by `instanceof`.
 */
export class PluginStaticAnalysisUnavailableError extends Error {
  override readonly name = 'PluginStaticAnalysisUnavailableError';

  constructor(
    /** Capability probe names the resolved parser failed. */
    public readonly failedCapabilities: readonly string[],
    /** The resolved parser's self-reported version; `'unknown'` when the build exports none. */
    public readonly parserVersion: string,
  ) {
    super(
      `Static analysis is unavailable: the resolved meriyah build (version ${parserVersion}) failed ` +
        `${failedCapabilities.length} parser capability probe(s) [${failedCapabilities.join(', ')}], so screening ` +
        'would run at partial coverage while reporting a complete scan. Check the dependency tree for a ' +
        'meriyah build shadowing the pinned major before relying on the scan.',
    );
  }
}
