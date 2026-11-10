import baseConfig, { i18nHardcodedStringSelectors } from '../../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    ignores: ['**/out-tsc'],
  },
  {
    // #145 guardrail: this lib is born on i18n, so a hardcoded user-facing
    // string fails the build. Specs are exempt: they assert on rendered English
    // copy on purpose.
    files: ['**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...i18nHardcodedStringSelectors],
    },
  },
];
