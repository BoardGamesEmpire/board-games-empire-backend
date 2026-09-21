import nx from '@nx/eslint-plugin';

// Repo-wide `no-restricted-imports` paths, keyed so individual libs can compose
// their own narrowly-scoped exceptions (see actor-context-transport) instead of
// blanket-disabling the rule. New restrictions added here flow into every
// project automatically, including those that opt out of a *different* entry.
export const restrictedImportPaths = {
  // Internal CLS populator + raw CLS keys live in the `@bge/actor-context`
  // barrel so the bundler inlines them, but only entry-point interceptors and
  // worker bases may use them. Application code and plugins must use the
  // read-only `AuditContextService` — this enforces "plugins have read-only
  // access to CLS actor; cannot forge" (issue #57).
  // The composed-scope registry's WRITER. It has to be exported from
  // `@bge/shared` for `ScopeComposer` (a different lib) to reach it, but a
  // service that calls it directly satisfies the `paginated()` guard without
  // composing anything — which turns the assertion into decoration. Same
  // shape, and the same reasoning, as the internal CLS populator below:
  // exported because the module graph requires it, restricted because nothing
  // outside its one sanctioned caller should touch it.
  composedScopeWriter: {
    name: '@bge/shared',
    importNames: ['recordComposedScope'],
    message:
      'Internal writer for the composed-scope registry. ScopeComposer only — a service calling this satisfies the paginated() guard without composing a scope, which is the erosion the guard exists to prevent (#365/#416). Inject ScopeComposer and call compose() instead.',
  },

  auditContextInternal: {
    name: '@bge/actor-context',
    importNames: [
      'AuditContextInternalService',
      'ABILITIES_CLS_KEY',
      'ACTOR_CLS_KEY',
      'CORRELATION_ID_CLS_KEY',
      'LOCALE_CLS_KEY',
      'SOURCE_CLS_KEY',
    ],
    message:
      'Internal CLS populator/keys. Entry-point interceptors and worker bases only — application and plugin code must use the read-only AuditContextService (issue #57).',
  },
};

// #365/#416 guardrail: a collection read must get its `where` from
// `ScopeComposer.compose()`, which ANDs the endpoint's own scope with the
// caller's ability ceiling. Calling `getCurrentResourceConditions` directly in
// a service means the ceiling IS the answer set, so the same route returns a
// different KIND of result to different callers — the defect #365 exists to
// remove.
//
// A required scope parameter on the composer only binds callers who already
// use it; this is what stops a newly written list from reaching past it. The
// runtime half (the keyed `paginated()` assertion) covers paginated reads —
// this covers the ones that never build an envelope at all, of which there are
// three today: `GET /quotas`, `GET /events/:eventId/attendees`, and that
// route's attendee game list.
//
// Opt-in PER LIB, exactly like the i18n selectors below: a lib's own
// `eslint.config.mjs` pulls this in once #417/#418 have swept its reads, so the
// guardrail grows with the sweep instead of red-CIing every unconverted lib on
// day one. Single-resource fetches and writes legitimately call the ability
// service directly (#365 binds collection reads only), so a converted lib uses
// an explicit `// eslint-disable-next-line no-restricted-syntax -- <reason>`
// for those rather than staying opted out wholesale.
export const unscopedListReadSelectors = [
  {
    selector: "CallExpression[callee.property.name='getCurrentResourceConditions']",
    message:
      "Collection reads must compose their intrinsic scope: inject ScopeComposer and call compose(resourceType, action, scope) so the endpoint names its own row set and the ability only clips it. Direct getCurrentResourceConditions in a service makes the caller's ceiling the answer set (#365/#416). Single-resource fetches and writes are exempt — disable this line with a reason.",
  },
];

// #145: CI guardrail against NEW hardcoded user-facing strings in libs already
// migrated by #144. These `no-restricted-syntax` selectors flag string/template
// literals passed to a `*Exception(...)` constructor or used as a `message:`
// value — both must instead carry a catalog key via `t()` (exceptions / success
// bodies) or `i18nValidationMessage()` (validators). Opt-in PER LIB: a migrated
// lib's own `eslint.config.mjs` imports this array into a `no-restricted-syntax`
// rule scoped to its source, so the guardrail grows as #144 lands lib-by-lib and
// never red-CIs a lib that hasn't been migrated yet. Genuinely non-user-facing
// cases use an explicit `// eslint-disable-next-line no-restricted-syntax --
// <reason>` escape hatch. `raw=/^['"]/` restricts to STRING literals (a numeric
// status code as an exception arg is not flagged); namespaced callees
// (`ns.FooException`) are a known gap — call sites here import exceptions directly.
export const i18nHardcodedStringSelectors = [
  {
    selector: 'NewExpression[callee.name=/Exception$/] > Literal[raw=/^[\'"]/]',
    message:
      "Hardcoded user-facing string in an exception. Use a catalog key: throw new NotFoundException(t('errors.…', { … })). (#144/#145)",
  },
  {
    selector: 'NewExpression[callee.name=/Exception$/] > TemplateLiteral',
    message:
      "Hardcoded user-facing template string in an exception. Move the copy to a catalog key and interpolate via t('errors.…', { … }). (#144/#145)",
  },
  {
    selector: "Property[key.name='message'] > Literal[raw=/^['\"]/]",
    message:
      "Hardcoded user-facing `message:` string. Use a catalog key: t('success.…') for response bodies or i18nValidationMessage('validation.…') on validators. (#144/#145)",
  },
  {
    selector: "Property[key.name='message'] > TemplateLiteral",
    message:
      "Hardcoded user-facing `message:` template string. Move the copy to a catalog key and interpolate via t('…', { … }). (#144/#145)",
  },
];

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: [
      '**/dist',
      '**/out-tsc',
      // Generated by the nestjs-i18n CLI and gitignored as of #260 — but still on
      // disk in any workspace that has typechecked or built, so it still reaches
      // ESLint and this entry is still required. Carries its own
      // `/* eslint-disable */`; ignore it here so the unused-disable-directive
      // rule doesn't warn on the generated header.
      '**/i18n.generated.ts',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints: [
            {
              sourceTag: '*',
              onlyDependOnLibsWithTags: ['*'],
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts', '**/*.js', '**/*.jsx', '**/*.cjs', '**/*.mjs'],
    // Override or add rules here
    rules: {
      'no-restricted-imports': ['error', { paths: Object.values(restrictedImportPaths) }],
    },
  },
];
