import {
  classifyImportSpecifier,
  FORBIDDEN_IMPORT_SPECIFIERS,
  resolveAliasedPackageName,
  WARNED_IMPORT_SPECIFIERS,
} from './forbidden-specifiers.js';

describe('classifyImportSpecifier', () => {
  it.each(FORBIDDEN_IMPORT_SPECIFIERS)("classifies '%s' as forbidden", (specifier) => {
    expect(classifyImportSpecifier(specifier)).toBe('forbidden');
  });

  it.each(WARNED_IMPORT_SPECIFIERS)("classifies '%s' as a warning", (specifier) => {
    expect(classifyImportSpecifier(specifier)).toBe('warning');
  });

  it('forbids the request-shaped builtins alongside the HTTP libraries that wrap them', () => {
    for (const specifier of ['http', 'node:http', 'https', 'node:https', 'http2', 'node:http2']) {
      expect(classifyImportSpecifier(specifier)).toBe('forbidden');
    }
  });

  it('keeps socket and file PRIMITIVES at warning — capability shape, not danger level', () => {
    for (const specifier of ['net', 'node:net', 'tls', 'node:tls', 'dgram', 'node:dgram', 'fs', 'node:fs']) {
      expect(classifyImportSpecifier(specifier)).toBe('warning');
    }
  });

  it('matches subpaths of a listed entry', () => {
    expect(classifyImportSpecifier('axios/lib/adapters/http')).toBe('forbidden');
    expect(classifyImportSpecifier('@bge/database/generated/client')).toBe('forbidden');
    expect(classifyImportSpecifier('.prisma/client/default')).toBe('forbidden');
    expect(classifyImportSpecifier('node:fs/promises')).toBe('warning');
  });

  it('does not match name PREFIXES that are not subpaths', () => {
    expect(classifyImportSpecifier('axios-retry')).toBeNull();
    expect(classifyImportSpecifier('undici-types')).toBeNull();
    expect(classifyImportSpecifier('fsevents')).toBeNull();
    expect(classifyImportSpecifier('http-errors')).toBeNull();
    expect(classifyImportSpecifier('https-proxy-agent')).toBeNull();
  });

  it('returns null for unlisted packages, unlisted builtins, and every relative import', () => {
    expect(classifyImportSpecifier('lodash')).toBeNull();
    expect(classifyImportSpecifier('node:path')).toBeNull();
    expect(classifyImportSpecifier('./local-module.js')).toBeNull();
    expect(classifyImportSpecifier('../lib/helper.js')).toBeNull();
  });

  it('keeps the two lists disjoint — one specifier, one verdict', () => {
    const forbidden = new Set(FORBIDDEN_IMPORT_SPECIFIERS);

    for (const warned of WARNED_IMPORT_SPECIFIERS) {
      expect(forbidden.has(warned)).toBe(false);
    }
  });
});

describe('resolveAliasedPackageName', () => {
  it('resolves the aliased package behind an npm: range', () => {
    expect(resolveAliasedPackageName('npm:axios@^1.7.0')).toBe('axios');
    expect(resolveAliasedPackageName('npm:axios@1.19.0')).toBe('axios');
  });

  it('preserves a scoped target, stripping only the range', () => {
    expect(resolveAliasedPackageName('npm:@bge/database@^0.0.1')).toBe('@bge/database');
    expect(resolveAliasedPackageName('npm:@scope/pkg')).toBe('@scope/pkg');
  });

  it('handles an alias with no range at all', () => {
    expect(resolveAliasedPackageName('npm:undici')).toBe('undici');
  });

  it('returns null for ordinary ranges and other protocols', () => {
    expect(resolveAliasedPackageName('^1.7.0')).toBeNull();
    expect(resolveAliasedPackageName('file:../local')).toBeNull();
    expect(resolveAliasedPackageName('git+https://example.test/p.git')).toBeNull();
    expect(resolveAliasedPackageName('npm:')).toBeNull();
  });

  it('composes with classification — the whole point of resolving the alias', () => {
    const resolved = resolveAliasedPackageName('npm:axios@^1');

    expect(resolved).not.toBeNull();
    expect(classifyImportSpecifier(resolved as string)).toBe('forbidden');
    // While the local name it hides behind screens clean on its own.
    expect(classifyImportSpecifier('my-http')).toBeNull();
  });
});
