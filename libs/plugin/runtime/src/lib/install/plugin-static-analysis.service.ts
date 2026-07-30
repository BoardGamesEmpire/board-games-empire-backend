import type { InstalledPluginDirectory } from '@boardgamesempire/plugin-contract';
import { classifyImportSpecifier, resolveAliasedPackageName } from '@boardgamesempire/plugin-manifest';
import { Injectable, Logger } from '@nestjs/common';
import { init, parse as parseEsm } from 'es-module-lexer';
import { parse as parseAst, type ESTree } from 'meriyah';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { PluginStaticAnalysisUnavailableError } from './install.errors';
import {
  MODULE_PARSE_OPTIONS,
  PARSER_CAPABILITY_PROBES,
  probeParserCapabilities,
  resolvedParserVersion,
  SCRIPT_PARSE_OPTIONS,
} from './parser-capabilities';
import {
  isGatingFinding,
  MAX_ADVISORY_FINDINGS,
  MAX_GATING_EXAMPLES_PER_SPECIFIER,
  type StaticAnalysisFinding,
  type StaticAnalysisFindingKind,
  type StaticAnalysisReport,
  type StaticAnalysisScanScope,
  type StaticAnalysisSeverity,
} from './static-analysis.types';

const SCANNABLE_EXTENSIONS = ['.js', '.mjs', '.cjs'] as const;
const NODE_MODULES = 'node_modules';
const LOCKFILE_NAME = 'package-lock.json';

/**
 * `package.json` fields whose entries the AUTHOR explicitly chose and which
 * are present (or demanded) at runtime, so a forbidden name in one is a real
 * capability decision: regular and optional dependencies are installed,
 * peers are demanded from the host — a plugin peer-depending on
 * `@prisma/client` is asking for the host's client by another route — and
 * `bundleDependencies` ship inside the tarball.
 *
 * `devDependencies` are deliberately absent: they are not installed in a
 * production tree, and gating on them would reject a plugin whose TEST
 * tooling uses `axios`. They are screened at warning severity instead.
 */
const GATING_DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;
const ADVISORY_DEPENDENCY_FIELDS = ['devDependencies'] as const;

/**
 * Kinds that name nothing. Useful in the plugin's own code (the author can
 * act on them); pure noise from `node_modules`, where `require(variable)`
 * appears in essentially every transpiled package — which is why the deep
 * pass drops them.
 */
const UNSCREENABLE_KINDS: ReadonlySet<StaticAnalysisFindingKind> = new Set([
  'non-literal-import',
  'non-literal-require',
  'read-failure',
  'parse-failure',
]);

export interface StaticAnalysisOptions {
  /**
   * Admin opt-in (D-AC): extend the scan into `node_modules`. Every finding
   * it produces is advisory — vendored code trips the specifier list
   * legitimately — so this exists for the admin who wants eyes on the whole
   * tree before confirming, never as a gate.
   */
  readonly deepScan: boolean;
}

/** Minimal structural view of an ESTree node — meriyah's AST walked without type assertions. */
interface EstreeNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface CollectedFiles {
  readonly files: readonly string[];
  /** Directories that could not be listed, so their contents were never screened. */
  readonly unreadableDirectories: readonly string[];
}

const isEstreeNode = (value: unknown): value is EstreeNode =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const errorCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string'
    ? (err as { code: string }).code
    : undefined;

/** A finding key that ignores `file` — the deep pass dedupes on this across the whole tree. */
const findingIdentity = (finding: StaticAnalysisFinding): string => `${finding.kind}\u0000${finding.specifier ?? ''}`;

/**
 * Install-time static analysis (#59 D-E): `es-module-lexer` for ESM import
 * specifiers, a `meriyah` AST pass for CJS `require(...)` calls, and
 * name-level screening of dependency descriptors (D-AC), with npm alias
 * ranges resolved so a renamed package cannot slip past every screen at once.
 *
 * What GATES is narrow and statable: the plugin's own source, and the
 * dependencies its author explicitly declared. Everything describing
 * third-party code — the resolved lockfile tree, vendored sources under the
 * opt-in deep scan — is ADVISORY, because a transitive package that wraps
 * `axios` is a legitimate occurrence and rejecting the install over it would
 * punish the author for a choice they did not make.
 *
 * Defense-in-depth by design (D-B): plugins are never mounted into host DI,
 * so a forbidden import would not resolve to a live service anyway — which
 * is why non-literal dynamic specifiers and unreadable or unparseable files
 * are WARNINGS in the audit payload, not rejections. Hard-failing on lazy
 * loading would punish legitimate patterns without stopping a determined
 * author. See `forbidden-specifiers.ts` for what this layer cannot see at
 * all.
 *
 * No plugin code executes here: lexing and parsing only.
 */
@Injectable()
export class PluginStaticAnalysisService {
  private readonly logger = new Logger(PluginStaticAnalysisService.name);
  private parserChecked = false;

  async analyze(directory: InstalledPluginDirectory, options: StaticAnalysisOptions): Promise<StaticAnalysisReport> {
    // Idempotent WASM initialization — resolved once, awaited every call.
    await init;
    this.assertParserSanity();

    const findings: StaticAnalysisFinding[] = [];
    const collected = await this.collectFiles(directory.rootDir, { intoNodeModules: false });

    for (const file of collected.files) {
      findings.push(...(await this.scanFile(directory.rootDir, file, 'default')));
    }

    findings.push(...this.unreadableDirectoryFindings(directory.rootDir, collected.unreadableDirectories, 'default'));
    findings.push(...(await this.screenDependencies(directory)));

    let deepScannedFileCount = 0;

    if (options.deepScan) {
      const deep = await this.collectFiles(join(directory.rootDir, NODE_MODULES), { intoNodeModules: true });
      deepScannedFileCount = deep.files.length;

      const deduped = new Map<string, StaticAnalysisFinding>();

      for (const file of deep.files) {
        for (const finding of await this.scanFile(directory.rootDir, file, 'deep')) {
          // Two-part noise control for a pass that walks an arbitrary
          // dependency tree: unscreenable kinds name nothing actionable
          // here, and a forbidden specifier is worth reporting ONCE with an
          // example file rather than once per vendored file that imports it.
          if (UNSCREENABLE_KINDS.has(finding.kind)) {
            continue;
          }

          const identity = findingIdentity(finding);

          if (!deduped.has(identity)) {
            deduped.set(identity, finding);
          }
        }
      }

      findings.push(...deduped.values());
      findings.push(...this.unreadableDirectoryFindings(directory.rootDir, deep.unreadableDirectories, 'deep'));
    }

    const { kept, truncated } = this.applyCaps(findings);

    if (truncated) {
      this.logger.warn(
        `Static analysis for '${directory.slug}' produced more findings than the report retains ` +
          `(advisory cap ${MAX_ADVISORY_FINDINGS}, ${MAX_GATING_EXAMPLES_PER_SPECIFIER} example(s) per gating ` +
          'specifier); the report is truncated. Every distinct gating specifier is still present.',
      );
    }

    this.logger.debug(
      `Static analysis for '${directory.slug}': ${collected.files.length} file(s) scanned` +
        `${options.deepScan ? `, ${deepScannedFileCount} deep-scanned` : ''}, ${kept.length} finding(s)`,
    );

    return { findings: kept, scannedFileCount: collected.files.length, deepScannedFileCount, truncated };
  }

  /**
   * Probe that the resolved parser can handle every syntax class the AST
   * pass depends on, run before the first scan and REFUSING to analyze when
   * any probe fails (#219 / D-AM). A capability gap means each file using
   * that syntax degrades to `parse-failure`, its `require()` calls go
   * unscreened, and the lexer-failure fallback is lost for it — partial
   * coverage presenting as a completed scan, which is the one report this
   * service must never produce.
   *
   * Module parsing alone was probed originally, and that certified a stale
   * meriyah 1.x which then failed on optional chaining, `??=`, private
   * fields, static blocks, and top-level await — most real 2026 plugin
   * code. The probe set now exercises those classes explicitly; see
   * `PARSER_CAPABILITY_PROBES` for the verified partition. Success is
   * cached; failure is not, so a broken environment throws on every attempt
   * rather than once.
   */
  private assertParserSanity(): void {
    if (this.parserChecked) {
      return;
    }

    const failedCapabilities = probeParserCapabilities();

    if (failedCapabilities.length > 0) {
      throw new PluginStaticAnalysisUnavailableError(failedCapabilities, resolvedParserVersion());
    }

    this.logger.debug(
      `meriyah ${resolvedParserVersion()} passed all ${PARSER_CAPABILITY_PROBES.length} parser capability probes`,
    );
    this.parserChecked = true;
  }

  private unreadableDirectoryFindings(
    rootDir: string,
    directories: readonly string[],
    scanScope: StaticAnalysisScanScope,
  ): StaticAnalysisFinding[] {
    return directories.map((directory) => ({
      file: relative(rootDir, directory) || '.',
      kind: 'read-failure',
      specifier: null,
      severity: 'warning',
      scanScope,
    }));
  }

  /**
   * Bound the report while keeping every gating SPECIFIER and the original
   * discovery order.
   *
   * Gating findings are exempt from the advisory budget — they are the
   * content of a rejection — but not from bounding altogether: an install the
   * admin accepts persists them, so each distinct specifier keeps a few
   * example files and the rest are dropped. The specifier set, which is what
   * the gate and the acknowledgement key on, is therefore always complete.
   */
  private applyCaps(findings: readonly StaticAnalysisFinding[]): {
    readonly kept: StaticAnalysisFinding[];
    readonly truncated: boolean;
  } {
    const kept: StaticAnalysisFinding[] = [];
    const examplesPerSpecifier = new Map<string, number>();
    let advisoryBudget = MAX_ADVISORY_FINDINGS;
    let truncated = false;

    for (const finding of findings) {
      if (isGatingFinding(finding)) {
        const specifier = finding.specifier ?? '';
        const seen = examplesPerSpecifier.get(specifier) ?? 0;

        if (seen < MAX_GATING_EXAMPLES_PER_SPECIFIER) {
          kept.push(finding);
          examplesPerSpecifier.set(specifier, seen + 1);
        } else {
          truncated = true;
        }

        continue;
      }

      if (advisoryBudget > 0) {
        kept.push(finding);
        advisoryBudget -= 1;
      } else {
        truncated = true;
      }
    }

    return { kept, truncated };
  }

  /**
   * Recursive walk collecting scannable files. Dirent checks are
   * lstat-shaped, so symlinked files and directories are skipped entirely:
   * a link out of the plugin directory must not turn the scanner into a
   * host-file reader — the loader's containment guards stay authoritative.
   *
   * A directory that cannot be listed is REPORTED, not swallowed: silently
   * returning no files would let an unreadable subtree read as a clean
   * complete scan, which is the one outcome this pass must never produce.
   * An absent directory is not an error — `node_modules` is optional.
   */
  private async collectFiles(root: string, options: { readonly intoNodeModules: boolean }): Promise<CollectedFiles> {
    const files: string[] = [];
    const unreadableDirectories: string[] = [];

    let entries;

    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') {
        this.logger.debug(`Static analysis could not list '${root}': ${err instanceof Error ? err.message : err}`);
        unreadableDirectories.push(root);
      }

      return { files, unreadableDirectories };
    }

    for (const entry of entries) {
      const path = join(root, entry.name);

      if (entry.isDirectory()) {
        if (!options.intoNodeModules && entry.name === NODE_MODULES) {
          continue;
        }

        const nested = await this.collectFiles(path, options);
        files.push(...nested.files);
        unreadableDirectories.push(...nested.unreadableDirectories);
        continue;
      }

      if (entry.isFile() && SCANNABLE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
        files.push(path);
      }
    }

    return { files, unreadableDirectories };
  }

  private async scanFile(
    rootDir: string,
    path: string,
    scanScope: StaticAnalysisScanScope,
  ): Promise<StaticAnalysisFinding[]> {
    const file = relative(rootDir, path);
    const collected = new Map<string, StaticAnalysisFinding>();
    const record = (
      kind: StaticAnalysisFindingKind,
      specifier: string | null,
      severity: StaticAnalysisSeverity,
    ): void => {
      const finding: StaticAnalysisFinding = { file, kind, specifier, severity, scanScope };
      collected.set(findingIdentity(finding), finding);
    };
    const classify = (kind: 'esm-import' | 'dynamic-import' | 'cjs-require', specifier: string): void => {
      const verdict = classifyImportSpecifier(specifier);

      if (verdict !== null) {
        record(kind, specifier, verdict);
      }
    };

    // Unreadable is a species of unscreenable, and every install rejection
    // must be a typed domain error: a mode-0000 file in an extracted tarball
    // (or one that vanishes between the walk and the read) becomes a finding
    // here rather than a raw EACCES escaping `install()`.
    let source: string;

    try {
      source = await readFile(path, 'utf-8');
    } catch (err) {
      this.logger.debug(
        `Static analysis could not read '${file}': ${err instanceof Error ? err.message : String(err)}`,
      );
      record('read-failure', null, 'warning');

      return [...collected.values()];
    }

    // ESM pass (D-E): static import/export-from specifiers plus dynamic
    // import() call sites, where a non-literal specifier is unscreenable and
    // therefore a warning.
    let lexerSucceeded = true;

    try {
      const [imports] = parseEsm(source);

      for (const entry of imports) {
        if (entry.d === -2) {
          continue; // import.meta — no specifier.
        }

        if (entry.n !== undefined) {
          classify(entry.d >= 0 ? 'dynamic-import' : 'esm-import', entry.n);
        } else if (entry.d >= 0) {
          record('non-literal-import', null, 'warning');
        }
      }
    } catch {
      lexerSucceeded = false;
    }

    // CJS pass (D-E): meriyah AST for require(...) calls. When the lexer
    // failed, the same walk also recovers import declarations so a file one
    // parser chokes on is still screened by the other.
    const program = this.parseProgram(source);

    if (program !== null) {
      this.walk(program, lexerSucceeded, classify, record);
    } else {
      // require() screening is unavailable for this file whatever the lexer
      // managed, so the file is not fully screened either way.
      record('parse-failure', null, 'warning');
    }

    return [...collected.values()];
  }

  private parseProgram(source: string): ESTree.Program | null {
    for (const options of [MODULE_PARSE_OPTIONS, SCRIPT_PARSE_OPTIONS]) {
      try {
        return parseAst(source, options);
      } catch {
        // Fall through to the next mode, then to the parse-failure warning.
      }
    }

    return null;
  }

  /**
   * Generic ESTree traversal over meriyah's output. Visits every node once;
   * extracts `require('...')` calls always, and import/export-from
   * declarations only as the fallback ESM source when the lexer failed.
   */
  private walk(
    node: unknown,
    lexerSucceeded: boolean,
    classify: (kind: 'esm-import' | 'dynamic-import' | 'cjs-require', specifier: string) => void,
    record: (kind: StaticAnalysisFindingKind, specifier: string | null, severity: StaticAnalysisSeverity) => void,
  ): void {
    if (Array.isArray(node)) {
      for (const child of node) {
        this.walk(child, lexerSucceeded, classify, record);
      }

      return;
    }

    if (!isEstreeNode(node)) {
      return;
    }

    if (node.type === 'CallExpression') {
      const callee = node['callee'];

      if (isEstreeNode(callee) && callee.type === 'Identifier' && callee['name'] === 'require') {
        const argument = Array.isArray(node['arguments']) ? (node['arguments'][0] as unknown) : undefined;

        if (isEstreeNode(argument) && argument.type === 'Literal' && typeof argument['value'] === 'string') {
          classify('cjs-require', argument['value']);
        } else {
          record('non-literal-require', null, 'warning');
        }
      }
    }

    if (!lexerSucceeded) {
      const isStaticEsm =
        node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration';

      if (isStaticEsm || node.type === 'ImportExpression') {
        const source = node['source'];

        if (isEstreeNode(source) && source.type === 'Literal' && typeof source['value'] === 'string') {
          classify(isStaticEsm ? 'esm-import' : 'dynamic-import', source['value']);
        } else if (node.type === 'ImportExpression') {
          record('non-literal-import', null, 'warning');
        }
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (key !== 'type' && (Array.isArray(value) || isEstreeNode(value))) {
        this.walk(value, lexerSucceeded, classify, record);
      }
    }
  }

  /**
   * Dependency screening by NAME (D-AC). Alias ranges are resolved on both
   * sides — the local name an alias hides behind is unlisted by
   * construction, and so is the `require()` of it, so without this the
   * rename defeats every screen and still reports clean.
   *
   * Severity follows authorship, not danger: what the author DECLARED gates,
   * what the resolver produced is advisory (see `lockfilePackageNames`).
   */
  private async screenDependencies(directory: InstalledPluginDirectory): Promise<StaticAnalysisFinding[]> {
    // Keyed without severity so one package cannot be reported twice for the
    // same descriptor, and resolved by UPGRADE so the strongest verdict wins
    // regardless of which field is visited first — a package listed in both
    // `devDependencies` and `bundleDependencies` gates.
    const byIdentity = new Map<string, StaticAnalysisFinding>();
    const screen = (
      packageName: string,
      file: string,
      kind: StaticAnalysisFindingKind,
      severity: StaticAnalysisSeverity,
    ): void => {
      if (classifyImportSpecifier(packageName) !== 'forbidden') {
        return;
      }

      const identity = `${file}\u0000${kind}\u0000${packageName}`;
      const existing = byIdentity.get(identity);

      if (existing !== undefined && existing.severity === 'forbidden') {
        return;
      }

      byIdentity.set(identity, { file, kind, specifier: packageName, severity, scanScope: 'default' });
    };

    const packageJson = await this.readJson(directory.packageJsonPath);

    if (packageJson !== null) {
      const screenField = (field: string, severity: StaticAnalysisSeverity): void => {
        const entries = packageJson[field];

        if (!isRecord(entries)) {
          return;
        }

        for (const [name, range] of Object.entries(entries)) {
          screen(name, 'package.json', 'declared-dependency', severity);

          const aliased = typeof range === 'string' ? resolveAliasedPackageName(range) : null;

          if (aliased !== null) {
            screen(aliased, 'package.json', 'declared-dependency', severity);
          }
        }
      };

      for (const field of GATING_DEPENDENCY_FIELDS) {
        screenField(field, 'forbidden');
      }

      for (const field of ADVISORY_DEPENDENCY_FIELDS) {
        screenField(field, 'warning');
      }

      // `bundleDependencies` is an array of names, not a range map — and its
      // members are literally shipped inside the tarball.
      const bundled = packageJson['bundleDependencies'] ?? packageJson['bundledDependencies'];

      if (Array.isArray(bundled)) {
        for (const name of bundled) {
          if (typeof name === 'string') {
            screen(name, 'package.json', 'declared-dependency', 'forbidden');
          }
        }
      }
    }

    const lockfile = await this.readJson(join(directory.rootDir, LOCKFILE_NAME));

    for (const name of this.lockfilePackageNames(lockfile)) {
      screen(name, LOCKFILE_NAME, 'lockfile-package', 'warning');
    }

    return [...byIdentity.values()];
  }

  private async readJson(path: string): Promise<Record<string, unknown> | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'));

      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Package names from an npm lockfile, at ADVISORY severity.
   *
   * A lockfile describes the RESOLVED tree, most of which is transitive: a
   * dependency that itself wraps `axios` is the same legitimate occurrence
   * the deep scan treats as advisory, and gating on it would reject a plugin
   * for a choice its author never made. Nothing here distinguishes direct
   * from transitive anyway — hoisting flattens both to top-level keys — and
   * the direct set is already screened, at gating severity, from
   * `package.json`. Reading it advisory also makes the `dev: true` flag moot
   * rather than something to interpret inconsistently with the
   * devDependencies policy.
   *
   * Three sources, because an alias is recorded differently in each:
   *
   * - v2/v3 `packages` KEYS (`node_modules/axios`, nested
   *   `node_modules/a/node_modules/@scope/b`) reduced to the segment after
   *   the last `node_modules/`.
   * - the v2/v3 entry's `name` field, the only place the REAL package appears
   *   for an alias: `"node_modules/my-http": { name: "axios" }`.
   * - v1 `dependencies`, walked RECURSIVELY (v1 nests transitive packages
   *   inside their parent rather than flattening), including `version`
   *   values that carry an `npm:` alias range.
   */
  private lockfilePackageNames(lockfile: Record<string, unknown> | null): ReadonlySet<string> {
    const names = new Set<string>();

    if (lockfile === null) {
      return names;
    }

    const packages = lockfile['packages'];

    if (isRecord(packages)) {
      const marker = `${NODE_MODULES}/`;

      for (const [key, entry] of Object.entries(packages)) {
        const index = key.lastIndexOf(marker);

        if (index !== -1) {
          names.add(key.slice(index + marker.length));
        }

        if (isRecord(entry) && typeof entry['name'] === 'string') {
          names.add(entry['name']);
        }
      }
    }

    this.collectV1LockfileNames(lockfile['dependencies'], names);

    return names;
  }

  /** v1 lockfiles nest transitive packages, so the whole tree has to be walked. */
  private collectV1LockfileNames(dependencies: unknown, names: Set<string>): void {
    if (!isRecord(dependencies)) {
      return;
    }

    for (const [name, entry] of Object.entries(dependencies)) {
      names.add(name);

      if (!isRecord(entry)) {
        continue;
      }

      if (typeof entry['version'] === 'string') {
        const aliased = resolveAliasedPackageName(entry['version']);

        if (aliased !== null) {
          names.add(aliased);
        }
      }

      this.collectV1LockfileNames(entry['dependencies'], names);
    }
  }
}
