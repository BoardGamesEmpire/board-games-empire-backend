import { classifyImportSpecifier, resolveAliasedPackageName } from '@boardgamesempire/plugin-manifest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * A plugin DataGateway (#1083, #1084) loads this library, so its code must
 * pass the static analysis that screens plugin code at install. It reaches
 * BGG only through the fetch it's handed, which for a plugin is the scoped
 * HTTP client that keeps it to the outbound domains an admin consented to
 * (#1082).
 */
const LIB_ROOT = join(__dirname, '..', '..');

/**
 * Every file the library ships: its TypeScript under src/, aside from specs
 * and the `testing/` helpers only specs use, which its lib build leaves out
 * too (#1082).
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      return entry.name === 'testing' ? [] : sourceFiles(path);
    }

    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

const files = sourceFiles(join(LIB_ROOT, 'src')).map((path) => ({
  name: relative(LIB_ROOT, path),
  source: ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true),
}));

/** What each file imports: import and export-from declarations, import() and require(). */
const imports = files.flatMap(({ name, source }) =>
  ts.preProcessFile(source.text, true, true).importedFiles.map(({ fileName }) => ({ file: name, specifier: fileName })),
);

/** Calls of a bare `fetch(...)`, which reach the global fetch rather than the one the driver is handed. */
function bareFetchCalls(source: ts.SourceFile): number {
  let calls = 0;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
      calls += 1;
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return calls;
}

describe('gateway-driver-boardgamegeek is safe for a plugin DataGateway to load', () => {
  it('has source files to check, so the checks below cannot pass by finding nothing', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(imports.length).toBeGreaterThan(0);
  });

  it('imports nothing plugin static analysis forbids, since the install would be refused', () => {
    expect(imports.filter(({ specifier }) => classifyImportSpecifier(specifier) === 'forbidden')).toEqual([]);
  });

  it("imports no Nest package, since a plugin DataGateway runs outside the server's Nest app", () => {
    expect(imports.filter(({ specifier }) => specifier.startsWith('@nestjs/'))).toEqual([]);
  });

  it("imports none of the server's other libraries, which hold server code a plugin DataGateway must not carry (#1084)", () => {
    expect(imports.filter(({ specifier }) => specifier.startsWith('@bge/'))).toEqual([]);
  });

  it('never calls the global fetch, which would bypass the outbound domains an admin consented to', () => {
    expect(files.filter(({ source }) => bareFetchCalls(source) > 0).map(({ name }) => name)).toEqual([]);
  });

  it('depends on nothing plugin static analysis forbids', () => {
    const packageJson = JSON.parse(readFileSync(join(LIB_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    const forbidden = Object.entries(packageJson.dependencies ?? {}).filter(
      ([name, range]) =>
        classifyImportSpecifier(name) === 'forbidden' ||
        classifyImportSpecifier(resolveAliasedPackageName(range) ?? name) === 'forbidden',
    );

    expect(forbidden).toEqual([]);
  });
});
