import baseConfig, { i18nHardcodedStringSelectors, unscopedListReadSelectors } from '../../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    ignores: ['**/out-tsc'],
  },
  {
    // #145 guardrail — this lib is migrated to i18n (#144), so new hardcoded
    // user-facing strings must fail the build. Specs are exempt: they assert on
    // rendered English copy on purpose.
    //
    // #365 guardrail — this lib's collection read composes its scope (#516), so
    // a new one that takes the caller's ceiling as its answer set must fail too.
    // ONE entry for both: a second `no-restricted-syntax` block would replace
    // this one's selectors rather than add to them.
    files: ['**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...i18nHardcodedStringSelectors, ...unscopedListReadSelectors],
    },
  },
];
