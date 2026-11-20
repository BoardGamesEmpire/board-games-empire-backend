'use strict';
/**
 * The rule lives in the root `eslint.config.mjs`, beside `no-nested-ceiling`;
 * see that rule's spec for why its spec sits here.
 *
 * A member that carries a comment or spans more than one line is "special".
 * A blank line goes before a special member and before the member after one;
 * between two plain one-line members there is none (#1318). With members
 * sorted (#1374), the order alone then decides every blank line.
 */
const { RuleTester } = require('eslint');
const tseslint = require('typescript-eslint');

const { bgePlugin } = require('../../../../eslint.config.mjs');

const rule = bgePlugin.rules['member-blank-lines'];

const ruleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
});

const required = [{ messageId: 'blankLineRequired' }];
const forbidden = [{ messageId: 'blankLineForbidden' }];

ruleTester.run('member-blank-lines', rule, {
  valid: [
    { name: 'a run of plain one-line members', code: 'interface A {\n  a: string;\n  b: string;\n  c: string;\n}' },
    {
      name: 'the first member, documented, needs no blank line above it',
      code: 'interface A {\n  /** Doc. */\n  a: string;\n\n  b: string;\n}',
    },
    {
      name: "#1318's example, sorted per #1374",
      code: [
        'interface DataGatewaySectionView {',
        '  capability: DataGatewayCapability;',
        '',
        "  /** The last failure, only while it's current. */",
        '  failure: SectionFailure | null;',
        '',
        '  lastLoadedAt: Date | null;',
        '}',
      ].join('\n'),
    },
    { name: 'class methods are out of scope', code: 'class A {\n  a() {}\n  b() {}\n}' },
    {
      name: 'a pair with a method on one side is out of scope',
      code: 'class A {\n  /** Doc. */\n  x = 1;\n  m() {}\n\n\n  y = 2;\n}',
    },
    { name: 'members on one line are left to Prettier', code: 'function f(p: { a: string; b: string }) {}' },
  ],
  invalid: [
    {
      name: 'a documented member gets a blank line above it',
      code: 'interface A {\n  a: string;\n  /** Doc. */\n  b: string;\n}',
      output: 'interface A {\n  a: string;\n\n  /** Doc. */\n  b: string;\n}',
      errors: required,
    },
    {
      name: 'the plain member after a documented one gets a blank line (#1318)',
      code: 'interface A {\n  /** Doc. */\n  a: string;\n  b: string;\n}',
      output: 'interface A {\n  /** Doc. */\n  a: string;\n\n  b: string;\n}',
      errors: required,
    },
    {
      name: 'a blank line between two plain members is removed (#1318)',
      code: 'interface A {\n  a: string;\n\n  b: string;\n}',
      output: 'interface A {\n  a: string;\n  b: string;\n}',
      errors: forbidden,
    },
    {
      name: 'a multi-line type-literal member gets a blank line above it',
      code: 'type T = {\n  a: string;\n  b: {\n    c: string;\n  };\n};',
      output: 'type T = {\n  a: string;\n\n  b: {\n    c: string;\n  };\n};',
      errors: required,
    },
    {
      name: 'a decorated class property, its decorator on its own line, gets a blank line',
      code: 'class A {\n  a = 1;\n  @IsString()\n  b!: string;\n}',
      output: 'class A {\n  a = 1;\n\n  @IsString()\n  b!: string;\n}',
      errors: required,
    },
    {
      name: 'a blank line between two plain class properties is removed',
      code: 'class A {\n  a = 1;\n\n  b = 2;\n}',
      output: 'class A {\n  a = 1;\n  b = 2;\n}',
      errors: forbidden,
    },
    {
      name: 'a line comment makes a member special, like a doc comment',
      code: 'interface A {\n  a: string;\n  // Why b.\n  b: string;\n}',
      output: 'interface A {\n  a: string;\n\n  // Why b.\n  b: string;\n}',
      errors: required,
    },
    {
      name: "a trailing comment stays on the member above's line",
      code: 'interface A {\n  a: string; // note a\n  /** Doc. */\n  b: string;\n}',
      output: 'interface A {\n  a: string; // note a\n\n  /** Doc. */\n  b: string;\n}',
      errors: required,
    },
    {
      name: 'a trailing comment does not make the member below special',
      code: 'interface A {\n  a: string; // note a\n\n  b: string;\n}',
      output: 'interface A {\n  a: string; // note a\n  b: string;\n}',
      errors: forbidden,
    },
    {
      name: 'two blank lines before a special member become one',
      code: 'interface A {\n  a: string;\n\n\n  /** Doc. */\n  b: string;\n}',
      output: 'interface A {\n  a: string;\n\n  /** Doc. */\n  b: string;\n}',
      errors: required,
    },
    {
      name: 'a type literal in a function parameter follows the same rules',
      code: 'function f(p: {\n  a: string;\n\n  b: string;\n}) {}',
      output: 'function f(p: {\n  a: string;\n  b: string;\n}) {}',
      errors: forbidden,
    },
  ],
});
