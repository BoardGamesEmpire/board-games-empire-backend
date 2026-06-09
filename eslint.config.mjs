import nx from "@nx/eslint-plugin";

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
    name: "@bge/actor-context",
    importNames: [
      "AuditContextInternalService",
      "ACTOR_CLS_KEY",
      "CORRELATION_ID_CLS_KEY",
      "SOURCE_CLS_KEY"
    ],
    message:
      "Internal CLS populator/keys. Entry-point interceptors and worker bases only — application and plugin code must use the read-only AuditContextService (issue #57)."
  }
};

export default [
  ...nx.configs["flat/base"],
  ...nx.configs["flat/typescript"],
  ...nx.configs["flat/javascript"],
  {
    ignores: [
      "**/dist",
      "**/out-tsc"
    ]
  },
  {
    files: [
      "**/*.ts",
      "**/*.tsx",
      "**/*.js",
      "**/*.jsx"
    ],
    rules: {
      "@nx/enforce-module-boundaries": [
        "error",
        {
          enforceBuildableLibDependency: true,
          allow: [
            "^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$"
          ],
          depConstraints: [
            {
              sourceTag: "*",
              onlyDependOnLibsWithTags: [
                "*"
              ]
            }
          ]
        }
      ]
    }
  },
  {
    files: [
      "**/*.ts",
      "**/*.tsx",
      "**/*.cts",
      "**/*.mts",
      "**/*.js",
      "**/*.jsx",
      "**/*.cjs",
      "**/*.mjs"
    ],
    // Override or add rules here
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: Object.values(restrictedImportPaths) }
      ]
    }
  }
];
