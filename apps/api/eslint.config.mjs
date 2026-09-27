import baseConfig, { i18nHardcodedStringSelectors } from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    // #145 guardrail, for the gateways only: their copy is migrated to i18n
    // (#180), and the rest of the app has not been swept. Specs are exempt:
    // they assert on rendered English copy on purpose. The selectors do not
    // see a literal passed to `WsConnectionRefusal` (not an `*Exception`) or
    // behind `??`, which the gateway specs cover instead.
    files: ['src/app/gateways/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...i18nHardcodedStringSelectors],
    },
  },
];
