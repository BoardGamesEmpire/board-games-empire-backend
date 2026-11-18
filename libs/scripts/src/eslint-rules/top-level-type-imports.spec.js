'use strict';
/**
 * The rule lives in the root `eslint.config.mjs`, beside `no-nested-ceiling`;
 * see that rule's spec for why its spec sits here.
 *
 * A name imported only as a type goes in an `import type` statement of its
 * own, never as an inline `type` specifier in a value import (#1317).
 * `consistent-type-imports` never reports a specifier that already says
 * `type`, so this rule does that half. An inline specifier is already erased,
 * so moving it is safe even in a file whose decorators emit metadata.
 */
const { RuleTester } = require('eslint');
const tseslint = require('typescript-eslint');

const { bgePlugin } = require('../../../../eslint.config.mjs');

const rule = bgePlugin.rules['top-level-type-imports'];

const ruleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
});

const errors = [{ messageId: 'inlineTypeSpecifier' }];

ruleTester.run('top-level-type-imports', rule, {
  valid: [
    { name: 'a type import statement', code: "import type { A } from 'm';" },
    { name: 'a value import', code: "import { B } from 'm';" },
    { name: 'a default and a named value import', code: "import B, { C } from 'm';" },
    { name: 'a namespace import', code: "import * as m from 'm';" },
    { name: 'a side-effect import', code: "import 'm';" },
  ],
  invalid: [
    {
      name: 'an inline specifier beside a value one moves to its own statement',
      code: "import { B, type A } from 'm';",
      output: "import type { A } from 'm';\nimport { B } from 'm';",
      errors,
    },
    {
      name: 'a statement of only inline specifiers becomes a type import, aliases kept',
      code: "import { type A, type C as D } from 'm';",
      output: "import type { A, C as D } from 'm';",
      errors,
    },
    {
      name: 'a default import keeps its statement without braces',
      code: "import B, { type A } from 'm';",
      output: "import type { A } from 'm';\nimport B from 'm';",
      errors,
    },
    {
      name: 'a multi-line list keeps its value specifiers in order',
      code: "import {\n  Alpha,\n  type Beta,\n  Gamma,\n  type Delta,\n} from '@bge/m';",
      output: "import type { Beta, Delta } from '@bge/m';\nimport { Alpha, Gamma } from '@bge/m';",
      errors,
    },
    {
      name: 'an aliased value specifier keeps its alias',
      code: "import { B as C, type A } from 'm';",
      output: "import type { A } from 'm';\nimport { B as C } from 'm';",
      errors,
    },
    {
      name: 'a comment inside the braces is reported but left for a hand fix',
      code: "import {\n  B, // why B\n  type A,\n} from 'm';",
      output: null,
      errors,
    },
  ],
});
