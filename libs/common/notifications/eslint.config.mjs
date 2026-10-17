import baseConfig, { unscopedListReadSelectors } from '../../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    // #365 guardrail — this lib's reads moved to the API edge to compose their
    // scope (#517), so a new one here that takes the caller's ceiling as its
    // answer set must fail. A block of its own: this lib sets no other
    // `no-restricted-syntax` entry for it to replace.
    files: ['**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...unscopedListReadSelectors],
    },
  },
  {
    ignores: ['**/out-tsc'],
  },
];
