import baseConfig, { i18nHardcodedStringSelectors, restrictedImportPaths } from '../../eslint.config.mjs';

// The api is the one role that migrates (#236), so its entry point is the one
// file that may hand the bootstrap the Prisma CLI migrator. Only that entry is
// dropped for it, and every other repo-wide restriction re-applies to main.ts
// unchanged. The entry restricts a single name, so narrowing it to none would
// still refuse `import * as` from `@bge/bootstrap` here.
const migratorAllowedImportPaths = Object.entries(restrictedImportPaths)
  .filter(([key]) => key !== 'prismaCliMigrator')
  .map(([, entry]) => entry);

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
  {
    files: ['src/main.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: migratorAllowedImportPaths }],
    },
  },
];
