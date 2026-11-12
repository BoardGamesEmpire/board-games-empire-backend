'use strict';
/**
 * The #145 guardrail's selectors live in the root `eslint.config.mjs`, and each
 * migrated lib feeds them to the core `no-restricted-syntax` rule. See
 * `no-nested-ceiling.spec.js` for why a spec of the root config sits here.
 */
const { RuleTester } = require('eslint');
const { builtinRules } = require('eslint/use-at-your-own-risk');
const tseslint = require('typescript-eslint');

const { i18nHardcodedStringSelectors } = require('../../../../eslint.config.mjs');

const ruleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
});

const options = (code) => ({ code, options: i18nHardcodedStringSelectors });

ruleTester.run('no-restricted-syntax (#145 selectors)', builtinRules.get('no-restricted-syntax'), {
  valid: [
    { name: 'a catalog key', ...options(`throw new NotFoundException(t('errors.language.not_found', { id }));`) },
    {
      // Its message is typed as a marker, so tsc refuses literal copy; the one
      // string it takes is its code (#1260).
      name: "a coded refusal's code",
      ...options(`throw new CodedHttpException(Http.Conflict, 'CATALOG_ENTRY_CHANGED', t('errors.x'));`),
    },
  ],
  invalid: [
    { name: 'literal copy', ...options(`throw new NotFoundException('Language not found');`), errors: 1 },
    { name: 'template copy', ...options('throw new NotFoundException(`Language ${id} not found`);'), errors: 1 },
    { name: 'literal message copy', ...options(`const body = { message: 'Saved' };`), errors: 1 },
  ],
});
