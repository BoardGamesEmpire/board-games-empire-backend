import baseConfig, { unscopedListReadSelectors } from '../../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    // #365 guardrail — this lib's collection reads take their ceiling from the
    // API edge (#517), so a new one that takes the caller's ceiling as its
    // answer set must fail. A block of its own: this lib sets no other
    // `no-restricted-syntax` entry for it to replace.
    files: ['**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...unscopedListReadSelectors],
    },
  },
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          ignoredFiles: ['{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}'],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
  {
    ignores: ['**/out-tsc'],
  },
];
