'use strict';
/**
 * The rule lives in the root `eslint.config.mjs`, beside `no-nested-ceiling`;
 * see that rule's spec for why its spec sits here.
 */
const { RuleTester } = require('eslint');
const tseslint = require('typescript-eslint');

const { bgePlugin } = require('../../../../eslint.config.mjs');

const rule = bgePlugin.rules['no-uncoded-exception-body'];

const ruleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
});

ruleTester.run('no-uncoded-exception-body', rule, {
  valid: [
    { name: 'a coded refusal through CodedHttpException', code: `throw new CodedHttpException(409, 'X', t('k'));` },
    { name: 'a whole-body marker, which names no code', code: `throw new NotFoundException(t('k'));` },
    { name: 'an object body with no code', code: `throw new BadRequestException({ message: t('k') });` },
    {
      name: "a gRPC status, whose code is the transport's own (#1260)",
      code: `throw new RpcException({ code: err.code, message: err.message });`,
    },
    { name: 'a class that is not an exception', code: `const payload = new Payload({ code: 'X' });` },
    {
      name: 'a CodedHttpException subclass passing its code on',
      code: `class FooRefusal extends CodedHttpException { constructor() { super(409, 'FOO', t('k')); } }`,
    },
    {
      name: 'a subclass of a class that is not an exception',
      code: `class Foo extends Payload { constructor() { super({ code: 'X' }); } }`,
    },
    {
      name: "a gRPC status subclass, whose code is the transport's own (#1260)",
      code: `class Foo extends RpcException { constructor() { super({ code: 1, message: 'm' }); } }`,
    },
  ],
  invalid: [
    {
      name: 'a coded body through a Nest exception',
      code: `throw new ConflictException({ code: 'X', message: t('k') });`,
      errors: [{ messageId: 'uncoded' }],
    },
    {
      name: 'a coded body through HttpException',
      code: `throw new HttpException({ code: 'X' }, 409);`,
      errors: [{ messageId: 'uncoded' }],
    },
    {
      name: 'a code given in shorthand',
      code: `throw new UnauthorizedException({ message: t('k'), code });`,
      errors: [{ messageId: 'uncoded' }],
    },
    {
      name: 'a code under a string key',
      code: `return new ServiceUnavailableException({ 'code': 'X', message: t('k') }, { cause });`,
      errors: [{ messageId: 'uncoded' }],
    },
    {
      name: "a coded body passed through an exception subclass's super call",
      code: `class FooRefusal extends ConflictException { constructor() { super({ code: 'FOO', message: t('k') }); } }`,
      errors: [{ messageId: 'uncoded' }],
    },
    {
      name: 'a coded body passed through the super call of a class expression',
      code: `const Foo = class extends HttpException { constructor() { super({ code: 'FOO' }, 409); } };`,
      errors: [{ messageId: 'uncoded' }],
    },
  ],
});
