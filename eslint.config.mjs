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

  // The composed-scope registry's WRITER. It has to be exported from
  // `@bge/shared` for `ScopeComposer` (a different lib) to reach it, but a
  // service that calls it directly satisfies the `paginated()` guard without
  // composing anything — which turns the assertion into decoration. Same
  // shape, and the same reasoning, as the internal CLS populator above:
  // exported because the module graph requires it, restricted because nothing
  // outside its one sanctioned caller should touch it.
  composedScopeWriter: {
    name: '@bge/shared',
    importNames: ['recordComposedScope'],
    message:
      'Internal writer for the composed-scope registry. ScopeComposer only — a service calling this satisfies the paginated() guard without composing a scope, which is the erosion the guard exists to prevent (#365/#416). Inject ScopeComposer and call compose() instead.',
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
// this one reaches reads that never build an envelope at all, of which three
// carry the ceiling-only shape today: `GET /quotas`,
// `GET /events/:eventId/attendees`, and that route's attendee game list.
//
// It catches ONE of the two omissions, and only that one. A ceiling used as
// the answer set is a CALL this selector can name. The inverse — an intrinsic
// filter with no ceiling ANDed onto it — is an ABSENT call, and no
// `no-restricted-syntax` selector can match the absence of something across a
// method body. `GET /webhook-subscriptions` is that second shape today (the
// ScopeComposer class doc walks through what it leaks), and neither half
// reaches it: it returns a bare array, so the runtime guard never runs for it
// either. What closes that one is 418 converting the read — not a wider
// selector, which cannot be written with this rule.
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
// <reason>` escape hatch. A file whose every exception is non-user-facing (the
// transport lib's gRPC interceptors) may instead be listed in that lib's
// `ignores`, with the reason beside it. `raw=/^['"]/` restricts to STRING
// literals (a numeric status code as an exception arg is not flagged);
// namespaced callees (`ns.FooException`) are a known gap — call sites here
// import exceptions directly.
//
// The last entry is not about a literal. An `each: true` validator's default
// reads "each value in tags must be a string", and a custom message drops that
// prefix, so such a decorator must name a `validation.each.*` key. Nothing else
// catches a base key there: the copy still reads plausibly.
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
  {
    selector:
      "ObjectExpression:has(> Property[key.name='each'][value.value=true]) > Property[key.name='message'] > CallExpression[callee.name='i18nValidationMessage'] > Literal:not([value=/^validation\\.each\\./])",
    message:
      'An `each: true` validator needs a `validation.each.*` key: a custom message drops the "each value in " prefix of the class-validator default. Add the key beside its base one in validation.json. (#144)',
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
