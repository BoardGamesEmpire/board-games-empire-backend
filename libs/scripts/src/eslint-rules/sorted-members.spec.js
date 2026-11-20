'use strict';
/**
 * Interface and type-literal members sort alphabetically (#1374), through
 * perfectionist's `sort-interfaces` and `sort-object-types`. Those rules are
 * third-party, so this spec pins the root config's options, which it imports
 * so the two can't drift apart, and the behaviour the sweep relies on: a doc
 * comment travels with its member, a trailing comment stays on its line, and
 * overloads keep their order, which decides how TypeScript resolves a call.
 */
const { RuleTester } = require('eslint');
const tseslint = require('typescript-eslint');
const { default: perfectionist } = require('eslint-plugin-perfectionist');

const { sortedMemberOptions } = require('../../../../eslint.config.mjs');

const ruleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
});

const options = [sortedMemberOptions];

ruleTester.run('sort-interfaces with the root options', perfectionist.rules['sort-interfaces'], {
  valid: [
    {
      name: 'natural order: field2 before field10',
      code: 'interface A { a: string; b: string; field2: number; field10: number }',
      options,
    },
    { name: 'case-insensitive: Alpha before beta', code: 'interface A { Alpha: string; beta: string }', options },
    {
      name: 'blank lines do not partition the sort; that layout is #1318',
      code: 'interface A {\n  a: string;\n\n  b: string;\n  c: string;\n}',
      options,
    },
  ],
  invalid: [
    {
      name: 'overloads of one name keep their relative order when another member moves above them',
      code: 'interface A { f(x: string): void; f(x: number): void; a: string }',
      output: 'interface A { a: string; f(x: string): void; f(x: number): void; }',
      options,
      errors: [{ messageId: 'unexpectedInterfacePropertiesOrder' }],
    },
    {
      name: 'overloads split by another member come together in their original order',
      code: 'interface A { f(x: number): void; a: string; f(x: string): void }',
      output: 'interface A { a: string; f(x: number): void; f(x: string): void }',
      options,
      errors: [{ messageId: 'unexpectedInterfacePropertiesOrder' }],
    },
    {
      name: 'a doc comment moves with its member; blank lines are left to #1318',
      code: 'interface A {\n  b: string;\n\n  /** Doc. */\n  a: string;\n}',
      output: 'interface A {\n  /** Doc. */\n  a: string;\n\n  b: string;\n}',
      options,
      errors: [{ messageId: 'unexpectedInterfacePropertiesOrder' }],
    },
    {
      name: "a trailing comment stays on its member's line",
      code: 'interface A {\n  b: string; // note b\n  a: string;\n}',
      output: 'interface A {\n  a: string;\n  b: string; // note b\n}',
      options,
      errors: [{ messageId: 'unexpectedInterfacePropertiesOrder' }],
    },
    {
      name: 'natural order: field10 after field2',
      code: 'interface A { field10: number; field2: number }',
      output: 'interface A { field2: number; field10: number; }',
      options,
      errors: [{ messageId: 'unexpectedInterfacePropertiesOrder' }],
    },
  ],
});

ruleTester.run('sort-object-types with the root options', perfectionist.rules['sort-object-types'], {
  valid: [
    { name: 'call signatures stay put', code: 'type T = { (x: string): void; (x: number): void }', options },
    { name: 'construct signatures stay put', code: 'type T = { new (x: string): T; new (x: number): T }', options },
  ],
  invalid: [
    {
      name: 'a type literal sorts like an interface',
      code: 'type T = { b: string; a: number }',
      output: 'type T = { a: number; b: string; }',
      options,
      errors: [{ messageId: 'unexpectedObjectTypesOrder' }],
    },
    {
      name: 'a type literal in a parameter sorts too',
      code: 'function f(p: { b: string; a: number }) {}',
      output: 'function f(p: { a: number; b: string; }) {}',
      options,
      errors: [{ messageId: 'unexpectedObjectTypesOrder' }],
    },
  ],
});
