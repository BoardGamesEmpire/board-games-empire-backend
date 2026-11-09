import baseConfig, { unscopedListReadSelectors } from '../../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    // #365 guardrail, kept so any collection read added here composes its
    // intrinsic scope: one that takes the caller's ceiling as its answer set
    // must fail. A block of its own: this lib sets no other
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
