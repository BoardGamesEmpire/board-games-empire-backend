import { version as meriyahVersion, parse } from 'meriyah';

/**
 * Both the modern and legacy option keys are passed on every parse.
 * `sourceType` is meriyah 7's API; `module` is 1.x's, retained (deprecated)
 * in 7. Passing only `sourceType` against a hoisted 1.x parses ESM in script
 * mode, which fails on the first `import` and degrades EVERY file to a
 * parse-failure warning — silently, since a failed parse is a warning by
 * design. Passing both is correct on either major (1.x honours the legacy
 * key), and `probeParserCapabilities` refuses builds that honour neither —
 * along with builds that honour the keys but not the syntax the scan
 * depends on.
 */
export const MODULE_PARSE_OPTIONS = { sourceType: 'module', module: true } as const;
export const SCRIPT_PARSE_OPTIONS = { sourceType: 'script', module: false } as const;

export type ParserParseOptions = typeof MODULE_PARSE_OPTIONS | typeof SCRIPT_PARSE_OPTIONS;

export interface ParserCapabilityProbe {
  /** Stable identifier, carried on `PluginStaticAnalysisUnavailableError.failedCapabilities`. */
  readonly capability: string;
  /** Minimal source exercising exactly this capability — parseable, never executed. */
  readonly source: string;
  readonly options: ParserParseOptions;
}

/**
 * Syntax the resolved parser must handle for `require()` screening to reach
 * every file (#219 / D-AM). The original probe was a bare import statement,
 * which certified a stale meriyah 1.x that then choked on most real 2026
 * plugin code — optional chaining, `??=`, private fields, static blocks,
 * top-level await — degrading each such file to a `parse-failure` WARNING
 * and silently losing its `require()` screening: partial coverage
 * presenting as a completed scan, the one report this layer must never
 * produce.
 *
 * The partition below is verified against the published packages: 7.2.0
 * passes all ten probes; 1.9.15 passes only the first two and fails the
 * remaining eight — under THESE parse options. 1.x does implement several
 * of the syntaxes (optional chaining included), but only behind its
 * `next: true` flag, which the analyzer never passes; reading the 1.x
 * parser source without the lexer's flag gate makes the partition look
 * looser than it is. The floor probes are kept — a build failing THOSE is
 * broken more fundamentally, and D-AM's fail-closed posture covers it the
 * same way.
 */
export const PARSER_CAPABILITY_PROBES: readonly ParserCapabilityProbe[] = [
  {
    capability: 'esm-module-parsing',
    source: "import probe from 'probe';\nexport const value = probe;",
    options: MODULE_PARSE_OPTIONS,
  },
  {
    capability: 'dynamic-import',
    source: "import('probe');",
    options: MODULE_PARSE_OPTIONS,
  },
  {
    capability: 'import-meta',
    source: 'export const url = import.meta.url;',
    options: MODULE_PARSE_OPTIONS,
  },
  {
    capability: 'optional-chaining',
    source: "const value = probe?.value?.['key'];",
    options: SCRIPT_PARSE_OPTIONS,
  },
  {
    capability: 'nullish-coalescing-assignment',
    source: 'let value; value ??= 1;',
    options: SCRIPT_PARSE_OPTIONS,
  },
  {
    capability: 'logical-assignment',
    source: 'let value = 0; value ||= 1; value &&= 2;',
    options: SCRIPT_PARSE_OPTIONS,
  },
  {
    capability: 'private-class-fields',
    source: 'class Probe { #value = 1; read() { return this.#value; } }',
    options: SCRIPT_PARSE_OPTIONS,
  },
  {
    capability: 'private-field-in-check',
    source: 'class Probe { #value; static has(candidate) { return #value in candidate; } }',
    options: SCRIPT_PARSE_OPTIONS,
  },
  {
    capability: 'static-initialization-block',
    source: 'class Probe { static value; static { Probe.value = 1; } }',
    options: SCRIPT_PARSE_OPTIONS,
  },
  {
    capability: 'top-level-await',
    source: "const loaded = await import('probe');",
    options: MODULE_PARSE_OPTIONS,
  },
];

/**
 * Runs every capability probe against the resolved parser and returns the
 * names of the ones it failed — empty when the parser is fit for a full
 * scan. Pure and side-effect free: the caller decides whether a non-empty
 * result is fatal (the analyzer refuses per D-AM) or diagnostic.
 */
export const probeParserCapabilities = (): readonly string[] => {
  const failed: string[] = [];

  for (const probe of PARSER_CAPABILITY_PROBES) {
    try {
      parse(probe.source, probe.options);
    } catch {
      failed.push(probe.capability);
    }
  }

  return failed;
};

/**
 * The resolved parser's self-reported version, for operator-facing
 * diagnostics when the capability probe refuses — "which meriyah did I
 * actually get" is the first question the error prompts. Accessed
 * defensively: the export exists on both known majors, but a build without
 * it must not turn a diagnostic read into its own crash.
 */
export const resolvedParserVersion = (): string => (typeof meriyahVersion === 'string' ? meriyahVersion : 'unknown');
