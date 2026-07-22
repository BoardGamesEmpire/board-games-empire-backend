import baseConfig, { i18nHardcodedStringSelectors } from '../../../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    ignores: ['**/out-tsc'],
  },
  {
    // #145 guardrail — this lib is migrated to i18n (#144), so new hardcoded
    // user-facing strings must fail the build. Specs are exempt: they assert on
    // rendered English copy on purpose.
    files: ['**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...i18nHardcodedStringSelectors],
    },
  },
];
