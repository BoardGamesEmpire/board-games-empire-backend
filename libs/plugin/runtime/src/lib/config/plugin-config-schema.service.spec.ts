import Ajv2020 from 'ajv/dist/2020';
import { PluginConfigSchemaUnusableError } from './config-schema.errors';
import { PluginConfigSchemaService } from './plugin-config-schema.service';

describe('PluginConfigSchemaService', () => {
  let service: PluginConfigSchemaService;

  beforeEach(() => {
    service = new PluginConfigSchemaService();
  });

  const validate = (
    schema: Record<string, unknown>,
    config: Record<string, unknown>,
    identity: { slug?: string; version?: string } = {},
  ) => service.validate({ slug: identity.slug ?? 'alpha', version: identity.version ?? '1.0.0', schema, config });

  describe('conforming payloads', () => {
    it('returns no issues for a payload matching the schema', () => {
      const schema = {
        type: 'object',
        properties: { apiKey: { type: 'string' }, retries: { type: 'integer', minimum: 0 } },
        required: ['apiKey'],
        additionalProperties: false,
      };

      expect(validate(schema, { apiKey: 'k-123', retries: 3 })).toEqual([]);
    });

    it('accepts anything under an empty schema — a plugin may declare no constraints', () => {
      expect(validate({}, { anything: ['goes', { here: true }] })).toEqual([]);
    });
  });

  describe('violations', () => {
    it('reports every violation with path, keyword, and message — collect-all, not first-failure', () => {
      const schema = {
        type: 'object',
        properties: { apiKey: { type: 'string' }, retries: { type: 'integer', minimum: 0 } },
        required: ['apiKey'],
        additionalProperties: false,
      };

      const issues = validate(schema, { retries: -1, unknown: true });

      expect(issues.length).toBeGreaterThanOrEqual(3);
      expect(issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ keyword: 'required' }),
          expect.objectContaining({ keyword: 'minimum', path: '/retries' }),
          expect.objectContaining({ keyword: 'additionalProperties' }),
        ]),
      );

      for (const issue of issues) {
        expect(typeof issue.message).toBe('string');
        expect(issue.message.length).toBeGreaterThan(0);
      }
    });

    it('asserts formats — ajv-formats is wired, not just installed', () => {
      const schema = {
        type: 'object',
        properties: { endpoint: { type: 'string', format: 'uri' } },
      };

      expect(validate(schema, { endpoint: 'https://example.test/hook' })).toEqual([]);
      expect(validate(schema, { endpoint: 'not a uri' })).toEqual([
        expect.objectContaining({ keyword: 'format', path: '/endpoint' }),
      ]);
    });

    it('evaluates draft 2020-12 keywords (prefixItems)', () => {
      const schema = {
        type: 'object',
        properties: { pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] } },
      };

      expect(validate(schema, { pair: ['x', 1] })).toEqual([]);
      expect(validate(schema, { pair: [1, 'x'] })).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: '/pair/0' })]),
      );
    });
  });

  describe('a payload the validator cannot get through (#1151)', () => {
    // A schema that refers to itself is run once per level of the payload, so
    // a payload nested deep enough overflows the stack inside the validator.
    const recursive = {
      $ref: '#/$defs/node',
      $defs: { node: { type: 'object', properties: { child: { $ref: '#/$defs/node' } } } },
    };

    const nested = (depth: number): Record<string, unknown> => {
      let node: Record<string, unknown> = {};

      for (let level = 0; level < depth; level++) {
        node = { child: node };
      }

      return node;
    };

    it('answers one root issue instead of the throw, and still judges the next payload', () => {
      expect(validate(recursive, nested(200_000))).toEqual([
        { path: '', keyword: 'uncheckable', message: 'the configuration could not be checked against the schema' },
      ]);

      // The schema is as usable as it was: the answer was about that payload.
      expect(validate(recursive, nested(3))).toEqual([]);
      expect(validate(recursive, { child: 'not an object' })).toEqual([
        expect.objectContaining({ keyword: 'type', path: '/child' }),
      ]);
    });
  });

  describe('author-schema tolerance', () => {
    it('tolerates unknown keywords instead of refusing the schema — author schemas are not held to ajv strict mode', () => {
      const schema = {
        type: 'object',
        properties: { theme: { type: 'string', 'x-ui-hint': 'dropdown' } },
      };

      expect(validate(schema, { theme: 'dark' })).toEqual([]);
    });

    it('is not confused by two plugins declaring the same $id', () => {
      const schema = { $id: 'https://plugins.example/config', type: 'object' };

      expect(validate(schema, {}, { slug: 'alpha' })).toEqual([]);
      expect(validate({ ...schema }, {}, { slug: 'beta' })).toEqual([]);
    });
  });

  describe('unusable schemas', () => {
    it('throws PluginConfigSchemaUnusableError when the schema cannot compile', () => {
      const schema = { type: 'object', properties: { a: { type: 123 } } };

      expect(() => validate(schema, {})).toThrow(PluginConfigSchemaUnusableError);
      expect(() => validate(schema, {})).toThrow(/alpha/);
    });

    it('classifies a schema that cannot even be serialised — ajv cannot compile one either', () => {
      const schema: Record<string, unknown> = { type: 'object', properties: {} };
      (schema['properties'] as Record<string, unknown>)['self'] = schema;

      expect(() => validate(schema, {})).toThrow(PluginConfigSchemaUnusableError);
    });

    it('refuses an asynchronous schema rather than letting its promise pass for a verdict', () => {
      const schema = { $async: true, type: 'object', properties: { a: { type: 'number' } }, required: ['a'] };

      // An async validator returns a Promise — truthy — so a violating
      // payload would read as conforming and the rejection would surface as
      // an unhandled rejection rather than a 422.
      expect(() => validate(schema, { a: 'not-a-number' })).toThrow(PluginConfigSchemaUnusableError);
      expect(() => validate(schema, { a: 1 })).toThrow(/\$async/);
    });

    it('carries slug and version — the operator must know which stored manifest is unusable', () => {
      const schema = { $ref: '#/definitions/missing' };

      try {
        validate(schema, {}, { slug: 'gamma', version: '2.1.0' });
        fail('expected PluginConfigSchemaUnusableError');
      } catch (err) {
        expect(err).toBeInstanceOf(PluginConfigSchemaUnusableError);
        expect((err as PluginConfigSchemaUnusableError).slug).toBe('gamma');
        expect((err as PluginConfigSchemaUnusableError).version).toBe('2.1.0');
      }
    });

    describe('assertUsable (#1151)', () => {
      // Separates "the schema cannot be used" from any document, so a caller
      // can rank that answer above the document's shape.
      const assertUsable = (schema: Record<string, unknown>) =>
        service.assertUsable({ slug: 'alpha', version: '1.0.0', schema });

      it('returns quietly for a schema that compiles', () => {
        expect(() => assertUsable({ type: 'object' })).not.toThrow();
      });

      it('throws PluginConfigSchemaUnusableError for a schema that cannot compile, and for an asynchronous one', () => {
        expect(() => assertUsable({ type: 'no-such-type' })).toThrow(PluginConfigSchemaUnusableError);
        expect(() => assertUsable({ $async: true })).toThrow(PluginConfigSchemaUnusableError);
      });
    });
  });

  describe('a schema that cannot be used is compiled once (#1151)', () => {
    // Dormancy is worked out from the schema on every read, so a schema that
    // fails to compile must not be compiled again by each of them.
    let compile: jest.SpyInstance;

    beforeEach(() => {
      compile = jest.spyOn(Ajv2020.prototype, 'compile');
    });

    afterEach(() => {
      compile.mockRestore();
    });

    const reasonFor = (schema: Record<string, unknown>, identity: { slug?: string; version?: string } = {}) => {
      try {
        validate(schema, {}, identity);
      } catch (err) {
        expect(err).toBeInstanceOf(PluginConfigSchemaUnusableError);

        return (err as Error).message;
      }

      throw new Error('expected PluginConfigSchemaUnusableError');
    };

    it.each([
      ['one that fails to compile', { type: 'object', properties: { a: { type: 'no-such-type' } } }],
      ['an asynchronous one', { $async: true, type: 'object' }],
    ])('answers %s from memory the second time, with the same reason', (_label, schema) => {
      const first = reasonFor(schema);
      const second = reasonFor({ ...schema });

      expect(second).toBe(first);
      expect(compile).toHaveBeenCalledTimes(1);

      // `assertUsable` and `warm` reach the same memory.
      expect(() => service.assertUsable({ slug: 'alpha', version: '1.0.0', schema })).toThrow(
        PluginConfigSchemaUnusableError,
      );
      service.warm({ slug: 'alpha', version: '1.0.0', schema });
      expect(compile).toHaveBeenCalledTimes(1);
    });

    it('names the plugin and version asked about, not the ones first refused under', () => {
      const schema = { type: 'no-such-type' };

      expect(reasonFor(schema, { slug: 'alpha', version: '1.0.0' })).toMatch(/'alpha'@1\.0\.0/);
      expect(reasonFor(schema, { slug: 'alpha', version: '1.0.0' })).toMatch(/'alpha'@1\.0\.0/);
      expect(reasonFor(schema, { slug: 'beta', version: '2.0.0' })).toMatch(/'beta'@2\.0\.0/);
    });

    it('compiles a repaired schema under the same slug and version: the memory follows the document', () => {
      expect(() => validate({ type: 'no-such-type' }, {})).toThrow(PluginConfigSchemaUnusableError);

      expect(validate({ type: 'object' }, {})).toEqual([]);
      expect(compile).toHaveBeenCalledTimes(2);
    });
  });

  describe('compiled-validator cache', () => {
    it('honours a changed schema at the SAME slug@version — a reinstall may bring a new document under the old version', () => {
      const schema: Record<string, unknown> = {
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'string' } },
      };

      expect(validate(schema, { a: 'x' })).toEqual([]);

      // Version alone is not a safe cache key: uninstall + reinstall of the
      // same version legitimately swaps the document, and serving the old
      // validator would reject config the new schema accepts (and vice versa).
      expect(validate({ ...schema, required: ['a', 'b'] }, { a: 'x' })).toEqual(
        expect.arrayContaining([expect.objectContaining({ keyword: 'required' })]),
      );
    });

    it('recompiles for a new version — an update brings a new schema under a new key', () => {
      const schema: Record<string, unknown> = {
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'string' } },
      };

      expect(validate(schema, { a: 'x' }, { version: '1.0.0' })).toEqual([]);

      schema['required'] = ['a', 'b'];

      expect(validate(schema, { a: 'x' }, { version: '1.1.0' })).toEqual(
        expect.arrayContaining([expect.objectContaining({ keyword: 'required' })]),
      );
    });
  });
});
