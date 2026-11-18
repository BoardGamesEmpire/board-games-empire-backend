import { Injectable } from '@nestjs/common';
import addFormats from 'ajv-formats';
import Ajv2020, { type AsyncValidateFunction, type ValidateFunction } from 'ajv/dist/2020';
import { createHash } from 'node:crypto';
import { PluginConfigSchemaUnusableError, type PluginConfigIssue } from './config-schema.errors';

export interface PluginConfigValidationInput {
  readonly config: Record<string, unknown>;
  /** The manifest's `config.schema` document, opaque until here. */
  readonly schema: Record<string, unknown>;
  readonly slug: string;
  /** The ACTIVE manifest version — the cache key half that makes recompiles follow updates. */
  readonly version: string;
}

/**
 * Evaluates config payloads against a manifest's `config.schema`
 * (#320; shared verbatim by the household/user config writes). The
 * supported dialect is pinned to JSON Schema draft 2020-12 — the same
 * dialect the manifest lib's own emitted artifact uses — via ajv's
 * dedicated 2020 build, with `ajv-formats` asserting format keywords.
 *
 * Author schemas are NOT held to ajv's strict mode: strict mode exists to
 * catch schema-author typos at development time, and refusing an installed
 * plugin's config surface over an unknown `x-*` annotation would turn a
 * lint into an outage. A schema that fails to COMPILE is different — that
 * is `PluginConfigSchemaUnusableError`, operator-actionable.
 *
 * Compiled validators are cached by `slug:version:<schema digest>`. Version
 * alone looks like enough — updates change the version — but uninstall +
 * reinstall legitimately brings a NEW document under the OLD version, and a
 * stale validator there is silent data loss: retained config the new schema
 * accepts would be rejected and reset. The digest makes the key follow the
 * document, so no eviction call site has to remember to fire. The key space
 * stays bounded by the distinct schemas a process actually sees. Each
 * compilation gets a fresh Ajv instance so one plugin's `$id`/`$ref`
 * registrations can never collide with another's.
 *
 * A schema that cannot be used is remembered under the same key, with the
 * compiler's reason (#1151). A unit's dormancy is worked out from the schema
 * on every read, so without it each ability resolution, inventory row and
 * catalog count for that plugin would pay a failed compile to learn the same
 * answer again. The digest keeps that safe as it keeps the validators safe:
 * another document under the same version is another key.
 */
@Injectable()
export class PluginConfigSchemaService {
  private readonly validators = new Map<string, ValidateFunction>();
  /** Why each schema that cannot be used was refused, by the validators' key. */
  private readonly unusable = new Map<string, string>();

  /**
   * Compiles and caches a schema ahead of the site that will validate against
   * it. Callers that validate inside a transaction use this first: ajv
   * generates code on compile, and paying that while holding a row lock puts
   * CPU time inside the lock window for no reason. Deliberately silent on an
   * unusable schema — what that means belongs to whoever validates (a
   * reinstall resets the retained config; a config write raises it to the
   * operator), and this is only an optimisation.
   */
  warm(input: Omit<PluginConfigValidationInput, 'config'>): void {
    try {
      this.compiledValidator(input);
    } catch {
      // See above: the validating caller owns the diagnosis.
    }
  }

  /**
   * Compiles and caches a schema, throwing `PluginConfigSchemaUnusableError`
   * when it cannot be used. `warm` without the silence: for a caller that has
   * to know the schema is usable before it looks at any document, because an
   * unusable schema outranks the document's own shape (#1151).
   */
  assertUsable(input: Omit<PluginConfigValidationInput, 'config'>): void {
    this.compiledValidator(input);
  }

  /**
   * Returns every violation (empty when the payload conforms); throws
   * `PluginConfigSchemaUnusableError` when the schema cannot compile.
   *
   * A validator that throws on a payload answers one root issue, not the
   * throw (#1151). A recursive schema run over a payload nested deep enough
   * overflows the stack, which says the payload cannot be checked and nothing
   * about the schema: another payload still validates. Stored documents are
   * judged on every read, so the throw would otherwise fail each of them.
   */
  validate(input: PluginConfigValidationInput): readonly PluginConfigIssue[] {
    const validator = this.compiledValidator(input);
    let conforms: boolean;

    try {
      conforms = validator(input.config);
    } catch {
      return [UNCHECKABLE_PAYLOAD];
    }

    if (conforms) {
      return [];
    }

    return (validator.errors ?? []).map((error): PluginConfigIssue => ({
      path: error.instancePath,
      keyword: error.keyword,
      message: error.message ?? error.keyword,
    }));
  }

  private compiledValidator(input: Omit<PluginConfigValidationInput, 'config'>): ValidateFunction {
    const { slug, version, schema } = input;
    let key: string;

    // The digest answers as the compile does: `JSON.stringify` throws on a
    // document ajv cannot compile either (a circular one blows ajv's stack),
    // and both answers belong to the operator as the same typed "this stored
    // schema is unusable", not as a bare TypeError surfacing an unclassified
    // 500. Such a document has no key to be remembered under; none can come
    // out of a JSON column.
    try {
      key = `${slug}:${version}:${digest(schema)}`;
    } catch (err) {
      throw new PluginConfigSchemaUnusableError(slug, version, reasonOf(err));
    }

    const cached = this.validators.get(key);

    if (cached !== undefined) {
      return cached;
    }

    const refused = this.unusable.get(key);

    if (refused !== undefined) {
      throw new PluginConfigSchemaUnusableError(slug, version, refused);
    }

    let compiled: ValidateFunction;

    try {
      compiled = compile(schema);
    } catch (err) {
      const reason = reasonOf(err);
      this.unusable.set(key, reason);

      throw new PluginConfigSchemaUnusableError(slug, version, reason);
    }

    this.validators.set(key, compiled);

    return compiled;
  }
}

/** What `validate` answers for a payload its validator threw on. */
const UNCHECKABLE_PAYLOAD: PluginConfigIssue = {
  path: '',
  keyword: 'uncheckable',
  message: 'the configuration could not be checked against the schema',
};

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Compiles one schema on a fresh Ajv instance, throwing when it cannot be
 * used.
 *
 * `$async: true` compiles to a validator that RETURNS A PROMISE and signals
 * violations by rejecting. Called synchronously that promise is simply
 * truthy, so every payload, including a violating one, would read as
 * conforming, and its unhandled rejection would take the process down.
 * Refused as unusable rather than special-cased: a config document has
 * nothing to await, and supporting it would push an await into every caller
 * for a capability no plugin needs. (Nested `$async` never reaches the test:
 * ajv refuses to compile it at all.)
 */
function compile(schema: Record<string, unknown>): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const compiled = ajv.compile(schema);

  if (isAsync(compiled)) {
    throw new Error('the config schema declares "$async": true; asynchronous config validation is not supported');
  }

  return compiled;
}

/** ajv types the async form as a separate interface, so the flag needs the widened view. */
function isAsync(validator: ValidateFunction): boolean {
  return (validator as Partial<AsyncValidateFunction>).$async === true;
}

/**
 * Content key for a schema document. `JSON.stringify` is key-order
 * sensitive, so two orderings of the same schema simply compile twice —
 * a wasted compile, never a wrong verdict.
 */
function digest(schema: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex');
}
