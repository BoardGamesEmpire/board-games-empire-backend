'use strict';
/**
 * `@typescript-eslint/consistent-type-imports` skips a file that contains a
 * decorator only when the parser knows `emitDecoratorMetadata` and
 * `experimentalDecorators` are on. No ESLint config here sets
 * `parserOptions.project`, so the parser reads them from `parserOptions`
 * alone, and the root config sets them through `decoratorParserOptions`.
 * Without them the autofix turns a constructor-injected class into
 * `import type`, its emitted metadata becomes `Object`, and Nest DI fails at
 * runtime (#1317). This spec pins the options the root config exports.
 */
const { RuleTester } = require('eslint');
const tseslint = require('typescript-eslint');

const { decoratorParserOptions } = require('../../../../eslint.config.mjs');

const rule = tseslint.plugin.rules['consistent-type-imports'];
const options = [{ prefer: 'type-imports', fixStyle: 'separate-type-imports' }];

const injected = [
  "import { DatabaseService } from 'm';",
  '@Injectable()',
  'class S {',
  '  constructor(private readonly db: DatabaseService) {}',
  '}',
].join('\n');

const undecorated = [
  "import { DatabaseService } from 'm';",
  'class S {',
  '  constructor(private readonly db: DatabaseService) {}',
  '}',
].join('\n');

const withFlags = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: decoratorParserOptions,
  },
});

withFlags.run('consistent-type-imports with the root decorator flags', rule, {
  valid: [
    { name: 'a decorated file reports nothing, so an injected class stays a value (#1317)', code: injected, options },
  ],
  invalid: [
    {
      name: 'a file without decorators gets a type import',
      code: undecorated,
      output: undecorated.replace('import {', 'import type {'),
      options,
      errors: [{ messageId: 'typeOverValue' }],
    },
  ],
});

const withoutFlags = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
});

withoutFlags.run('consistent-type-imports without the decorator flags', rule, {
  valid: [],
  invalid: [
    {
      name: 'the hazard the flags prevent: the injected class would become a type import (#1317)',
      code: injected,
      output: injected.replace('import {', 'import type {'),
      options,
      errors: [{ messageId: 'typeOverValue' }],
    },
  ],
});
