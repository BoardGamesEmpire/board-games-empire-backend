import baseConfig, {
  i18nHardcodedStringSelectors,
  restrictedImportPaths,
  unscopedListReadSelectors,
} from '../../eslint.config.mjs';

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
    //
    // #365 guardrail, for the gateways too: the search gateway's local half
    // reads within a composed scope (#513), so a gateway that takes the
    // caller's ceiling as its answer set must fail. ONE entry for both: a
    // second `no-restricted-syntax` block would replace this one's selectors
    // rather than add to them.
    files: ['src/app/gateways/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...i18nHardcodedStringSelectors, ...unscopedListReadSelectors],
    },
  },
  {
    files: ['src/main.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: migratorAllowedImportPaths }],
    },
  },
];
