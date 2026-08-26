import {
  bindTemplate,
  extractSqlTemplate,
  extractValueTemplate,
  parameterMismatch,
  shapeMismatch,
  type ShippedStatement,
} from './shipped-sql';

/**
 * The extractor exists so the concurrency suite executes the statement the
 * application SHIPS rather than a copy of it (#239). A copy is worse than no
 * test: it goes on proving that some SQL blocks long after the service's own
 * SQL stopped resembling it, and the mechanics proof this issue exists for
 * would be silently vacuous.
 *
 * Reading source as text — rather than importing `@bge/household` — keeps the
 * black-box rule intact (#255 revised D-6): the test process still never loads
 * application code into itself. The precedent is #248's identifier spec, which
 * parses `prisma/models/*.prisma` for the same reason.
 */
describe('extractSqlTemplate', () => {
  const wrap = (body: string, name = 'lockSomething'): string => `
    async function ${name}(tx) {
      const rows = await tx.$queryRaw(Prisma.sql\`${body}\`);

      return rows;
    }
  `;

  it('replaces each interpolation with a positional parameter, in order', () => {
    const statement = extractSqlTemplate(
      wrap('SELECT id FROM households WHERE id = ${householdId} AND name = ${name}'),
      'households.ts',
    );

    expect(statement.text).toBe('SELECT id FROM households WHERE id = $1 AND name = $2');
  });

  it('returns the interpolated expressions verbatim, so a spec can pin what it binds', () => {
    const statement = extractSqlTemplate(
      wrap('SELECT id FROM x WHERE a = ${householdId} AND b = ${SystemRole.HouseholdOwner}'),
      'x.ts',
    );

    expect(statement.params).toEqual(['householdId', 'SystemRole.HouseholdOwner']);
  });

  it('preserves the statement across lines, trimming only the surrounding indentation', () => {
    const statement = extractSqlTemplate(
      wrap('\n      SELECT hr.household_member_id\n      FROM household_roles hr\n      FOR UPDATE OF hr\n    '),
      'members.ts',
    );

    expect(statement.text).toMatch(/^SELECT hr\.household_member_id/);
    expect(statement.text).toMatch(/FOR UPDATE OF hr$/);
    expect(statement.text).toContain('FROM household_roles hr');
  });

  it('handles braces inside an interpolation rather than ending the expression at the first one', () => {
    const statement = extractSqlTemplate(wrap('SELECT ${pick({ a: 1 })} FROM x'), 'x.ts');

    expect(statement).toEqual<ShippedStatement>({ text: 'SELECT $1 FROM x', params: ['pick({ a: 1 })'] });
  });

  it('trims the statement, because SQL is laid out across lines', () => {
    // The counterpart to the value form's verbatim lift below: indentation in a
    // statement is formatting, and `pg` should not receive it.
    expect(extractSqlTemplate(wrap('\n      SELECT 1\n    '), 'x.ts').text).toBe('SELECT 1');
  });

  it('names the file when the source carries no raw SQL template', () => {
    expect(() => extractSqlTemplate('const x = 1;', 'quiet.ts')).toThrow(/quiet\.ts/);
  });

  it('picks the template that follows a named anchor', () => {
    // Two locks now live in `household-access.helpers.ts`, and both files this
    // suite reads are free to grow another. The anchor is the function name,
    // so a spec says which statement it means instead of relying on there
    // being only one.
    const two = `${wrap('SELECT 1 FROM only_this')}\n${wrap('SELECT 2 FROM not_this')}`.replace(
      'lockSomething',
      'lockFirstThing',
    );

    expect(extractSqlTemplate(two, 'two.ts', { after: 'lockSomething' }).text).toBe('SELECT 2 FROM not_this');
    expect(extractSqlTemplate(two, 'two.ts', { after: 'lockFirstThing' }).text).toBe('SELECT 1 FROM only_this');
  });

  it('names the anchor it could not find, rather than falling back to the first template', () => {
    expect(() => extractSqlTemplate(wrap('SELECT 1'), 'x.ts', { after: 'lockNothing' })).toThrow(/lockNothing/);
  });

  it('anchors on the declaration, not on a doc comment that merely mentions it', () => {
    // The hazard is quiet and entirely plausible: adding
    // `{@link lockSecond}` to the FIRST function's docstring would otherwise
    // retarget this extraction onto the first statement, and when both
    // statements bind the same parameters nothing downstream notices.
    const source = [
      '/**',
      ' * The other half of this pair is {@link lockSecond}.',
      ' */',
      wrap('SELECT 1 FROM first'),
      '// see lockSecond, below',
      wrap('SELECT 2 FROM second', 'lockSecond'),
    ].join('\n');

    expect(extractSqlTemplate(source, 'pair.ts', { after: 'lockSecond' }).text).toBe('SELECT 2 FROM second');
  });

  it('anchors on a whole name, not on a prefix of a longer one', () => {
    // `lockHouseholdUnit` is a prefix of `lockHouseholdUnitScope`, and the
    // plugin runtime ships both — one importing the other at the top of the
    // file, far above either statement. A substring anchor resolves to the
    // import and lifts whichever template happens to follow it, which is a
    // silently wrong test whenever the two bind the same parameters.
    const source = [
      "import { lockUnitScope } from './unit-scope-lock';",
      'async function lockUnitScope(tx) {',
      '  await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;',
      '}',
      'async function lockUnit(tx) {',
      '  return tx.$queryRaw`SELECT id FROM units WHERE id = ${unitId} FOR UPDATE`;',
      '}',
    ].join('\n');

    const statement = extractSqlTemplate(source, 'units.ts', { after: 'lockUnit' });

    expect(statement.text).toBe('SELECT id FROM units WHERE id = $1 FOR UPDATE');
    expect(statement.params).toEqual(['unitId']);
  });

  it('refuses when the anchor appears only in prose', () => {
    const source = ['/**', ' * {@link lockElsewhere} lives in another file.', ' */', wrap('SELECT 1')].join('\n');

    expect(() => extractSqlTemplate(source, 'x.ts', { after: 'lockElsewhere' })).toThrow(/only inside comments/);
  });

  it('refuses when the anchor names both a call site and a declaration with different statements', () => {
    // `lockHouseholdOwnerRows` is called 600 lines above where it is declared,
    // and an anchor takes the FIRST non-comment mention. Today the file holds
    // one statement so both mentions resolve to it; the moment it holds two,
    // the call site silently retargets the lift onto a neighbour's statement.
    // Refusing is the same instinct as refusing to pick one of two templates.
    const source = [
      'async function caller(tx) {',
      '  await this.lockUnit(tx);',
      '  return tx.$queryRaw`SELECT 1 FROM not_this`;',
      '}',
      'async function lockUnit(tx) {',
      '  return tx.$queryRaw`SELECT 2 FROM this_one`;',
      '}',
    ].join('\n');

    expect(() => extractSqlTemplate(source, 'service.ts', { after: 'lockUnit' })).toThrow(/lockUnit/);
    expect(() => extractSqlTemplate(source, 'service.ts', { after: 'lockUnit' })).toThrow(/more than once/i);
  });

  it('accepts an anchor whose mentions all resolve to the same statement', () => {
    // The case above is only a problem when the mentions disagree. A call site
    // above a single-statement file resolves to the same template the
    // declaration does, and refusing there would fail every existing spec for
    // no gain.
    const source = [
      'async function caller(tx) {',
      '  await this.lockUnit(tx);',
      '}',
      'async function lockUnit(tx) {',
      '  return tx.$queryRaw`SELECT 1 FROM only_this`;',
      '}',
    ].join('\n');

    expect(extractSqlTemplate(source, 'service.ts', { after: 'lockUnit' }).text).toBe('SELECT 1 FROM only_this');
  });

  it('refuses to guess when the source carries more than one template', () => {
    // Guessing is the failure mode worth designing against: picking the wrong
    // one of two statements produces a passing test for a statement nobody
    // asked about.
    const two = `${wrap('SELECT 1')}\n${wrap('SELECT 2')}`;

    expect(() => extractSqlTemplate(two, 'two.ts')).toThrow(/2 raw SQL templates/);
  });

  it('reports an unterminated template rather than returning the rest of the file', () => {
    expect(() => extractSqlTemplate('const q = Prisma.sql`SELECT 1 FROM x', 'ragged.ts')).toThrow(/unterminated/i);
  });

  /**
   * The plugin runtime (#383) tags its raw statements directly on the client —
   * `tx.$queryRaw` and `tx.$executeRaw` — where the household services wrap
   * theirs in `Prisma.sql`. Both forms ship; both have to be liftable, or the
   * plugin locks stay provable only against a copy (D-360-1). #387 tracks
   * settling the repo on one idiom, after which this widening narrows again.
   */
  describe('the bare tagged forms the plugin runtime uses', () => {
    it('lifts a $queryRaw template that has no Prisma.sql wrapper', () => {
      const source = 'const rows = await tx.$queryRaw`SELECT id FROM plugins WHERE id = ${plugin.id} FOR SHARE`;';
      const statement = extractSqlTemplate(source, 'units.ts');

      expect(statement.text).toBe('SELECT id FROM plugins WHERE id = $1 FOR SHARE');
      expect(statement.params).toEqual(['plugin.id']);
    });

    it('lifts a $executeRaw template', () => {
      const source = 'await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scopeKey}, 0))`;';

      expect(extractSqlTemplate(source, 'lock.ts').text).toBe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))');
    });

    it('steps over a generic type argument between the tag and the template', () => {
      // `tx.$queryRaw<LockedUnitSqlRow[]>` — the row type sits where the
      // backtick would otherwise be, and a tag pattern that demanded one
      // immediately would silently find no template at all.
      const source = 'const rows = await tx.$queryRaw<LockedUnitSqlRow[]>`SELECT id FROM user_plugins FOR UPDATE`;';

      expect(extractSqlTemplate(source, 'grants.ts').text).toBe('SELECT id FROM user_plugins FOR UPDATE');
    });

    it('steps over a multi-line inline row type, nested angle brackets and all', () => {
      // `assertStillLiving`'s actual shape: the type argument spans lines and
      // closes with `>>`, so the scan cannot stop at the first `>` it sees.
      const source = [
        'const rows = await tx.$queryRaw<',
        '  Array<{ uninstalled_at: Date | null; scope: PluginScope; version: string }>',
        '>`SELECT uninstalled_at, scope, version FROM plugins WHERE id = ${plugin.id} FOR SHARE`;',
      ].join('\n');

      const statement = extractSqlTemplate(source, 'units.ts');

      expect(statement.text).toBe('SELECT uninstalled_at, scope, version FROM plugins WHERE id = $1 FOR SHARE');
      expect(statement.params).toEqual(['plugin.id']);
    });

    it('counts a Prisma.sql wrapped in $queryRaw once, not twice', () => {
      // Both tags are present on the household statements. Counting the pair
      // as two templates would make every existing single-statement file look
      // ambiguous and refuse to lift anything.
      const source = 'const rows = await tx.$queryRaw(Prisma.sql`SELECT 1 FROM households`);';

      expect(extractSqlTemplate(source, 'households.ts').text).toBe('SELECT 1 FROM households');
    });

    it('counts a generic-typed wrapped statement and a later bare one as two', () => {
      // The lazy generic group is bounded by the backtick for a reason. Left
      // unbounded it backtracks straight past `(Prisma.sql`…`)` and on to the
      // NEXT statement's `>`, swallowing both into one match — which silently
      // turns the "exactly one template" refusal that the plugin and quota
      // specs lean on into a lift of whichever statement came second.
      const source = [
        'const a = await tx.$queryRaw<A[]>(Prisma.sql`SELECT 1 FROM first`);',
        'const b = await tx.$queryRaw<B[]>`SELECT 2 FROM second`;',
      ].join('\n');

      expect(() => extractSqlTemplate(source, 'two.ts')).toThrow(/2 raw SQL templates/);
    });

    it('still refuses to guess between one wrapped and one bare statement', () => {
      const source = [
        'const a = await tx.$queryRaw(Prisma.sql`SELECT 1`);',
        'const b = await tx.$queryRaw`SELECT 2`;',
      ].join('\n');

      expect(() => extractSqlTemplate(source, 'two.ts')).toThrow(/2 raw SQL templates/);
    });
  });
});

/**
 * Key derivations are not SQL, and the advisory locks are keyed on one
 * (D-360-1). `plugin_grant:household_unit:${householdId}:${pluginId}` is built
 * in TypeScript a line above the statement that hashes it, so lifting only the
 * statement leaves the spec free to invent its own key format — and a barrier
 * whose two sides agree on a format production no longer uses blocks
 * beautifully while proving nothing.
 */
describe('extractValueTemplate', () => {
  it('lifts a template assigned to a const', () => {
    const source = 'const scopeKey = `plugin_grant:user_unit:${userId}:${pluginId}`;';
    const statement = extractValueTemplate(source, 'unit-scope-lock.ts');

    expect(statement.text).toBe('plugin_grant:user_unit:$1:$2');
    expect(statement.params).toEqual(['userId', 'pluginId']);
  });

  it('lifts a template passed straight to a call', () => {
    // `createHash('sha1').update(`quota:${resource}:${scope}:${scopeId}`)` —
    // the key never lands in a variable at all.
    const source = "createHash('sha1').update(`quota:${resource}:${scope}:${scopeId}`).digest();";
    const statement = extractValueTemplate(source, 'quota.service.ts');

    expect(statement.text).toBe('quota:$1:$2:$3');
    expect(statement.params).toEqual(['resource', 'scope', 'scopeId']);
  });

  it('ignores tagged templates, which are the SQL extractor’s business', () => {
    const source = ['const scopeKey = `plugin:${id}`;', 'await tx.$executeRaw`SELECT 1`;'].join('\n');

    expect(extractValueTemplate(source, 'lock.ts').text).toBe('plugin:$1');
  });

  it('ignores a template that lives inside a doc comment', () => {
    // Doc comments in this repo quote code, and a quoted key format is
    // indistinguishable from the real one to a pattern that only looks at the
    // character before the backtick. `unit-scope-lock.ts` already carries one.
    const source = [
      '/**',
      ' * The key is built as (`plugin_grant:household_unit:${id}`) — see below.',
      ' */',
      'const scopeKey = `plugin_grant:user_unit:${userId}:${pluginId}`;',
    ].join('\n');

    const statement = extractValueTemplate(source, 'lock.ts');

    expect(statement.text).toBe('plugin_grant:user_unit:$1:$2');
    expect(statement.params).toEqual(['userId', 'pluginId']);
  });

  it('picks the template following a named anchor', () => {
    const source = [
      'function lockHousehold(a, b) {',
      '  const scopeKey = `household:${a}:${b}`;',
      '}',
      'function lockUser(a, b) {',
      '  const scopeKey = `user:${a}:${b}`;',
      '}',
    ].join('\n');

    expect(extractValueTemplate(source, 'lock.ts', { after: 'lockUser' }).text).toBe('user:$1:$2');
  });

  it('preserves surrounding whitespace, which a key format may legitimately carry', () => {
    // The SQL path trims because a statement is free-form text laid out across
    // lines. A key is the string itself: trimming it would have both sides of a
    // barrier agree on a key production never takes, block exactly as expected,
    // and prove nothing — the precise failure D-360-1 exists to prevent.
    const statement = extractValueTemplate('const k = ` padded:${id} `;', 'x.ts');

    expect(statement.text).toBe(' padded:$1 ');
  });

  it('refuses an interpolation that abuts a digit, rather than emitting an ambiguous placeholder', () => {
    // `${prefix}2` lifts as `$12`, which reads back as placeholder twelve. Below
    // twelve interpolations that surfaces as a confusing throw; at twelve or
    // more it silently binds the wrong value into the key.
    expect(() => extractValueTemplate('const k = `plugin_grant:${prefix}2:${id}`;', 'x.ts')).toThrow(
      /ambiguous|abuts|adjacent/i,
    );
  });

  it('refuses to guess between two value templates', () => {
    const source = ['const a = `first:${x}`;', 'const b = `second:${y}`;'].join('\n');

    expect(() => extractValueTemplate(source, 'two.ts')).toThrow(/2 value templates/);
  });

  it('names the file when there is no value template to lift', () => {
    expect(() => extractValueTemplate('const x = 1;', 'quiet.ts')).toThrow(/quiet\.ts/);
  });
});

describe('bindTemplate', () => {
  const template: ShippedStatement = { text: 'plugin_grant:user_unit:$1:$2', params: ['userId', 'pluginId'] };

  it('substitutes positionally, reproducing the string the application would build', () => {
    expect(bindTemplate(template, ['user-1', 'plugin-9'])).toBe('plugin_grant:user_unit:user-1:plugin-9');
  });

  it('reports a placeholder the template never created, instead of calling itself unreachable', () => {
    // A literal `$5` written in the template body is indistinguishable from a
    // placeholder once the text is built. The bind refuses it by name rather
    // than substituting something arbitrary into a key.
    const literal: ShippedStatement = { text: 'costs:$5:$1', params: ['id'] };

    expect(() => bindTemplate(literal, ['abc'])).toThrow(/\$5/);
    expect(() => bindTemplate(literal, ['abc'])).not.toThrow(/unreachable/);
  });

  it('refuses an arity mismatch rather than emitting a key with a hole in it', () => {
    // A `$2` left unsubstituted is still a valid advisory key, so both sides of
    // a barrier would agree on it and block exactly as expected — while
    // proving nothing about the key production uses.
    expect(() => bindTemplate(template, ['user-1'])).toThrow(/2 value\(s\)/);
  });
});

describe('shapeMismatch', () => {
  const statement: ShippedStatement = { text: 'SELECT h.id FROM households h WHERE h.id = $1 FOR SHARE', params: [] };

  it('passes silently when the lifted statement is the one the spec means', () => {
    expect(shapeMismatch(statement, /FOR SHARE/, 'helpers.ts')).toBeUndefined();
  });

  it('reports a statement that does not carry the clause the spec is about to test', () => {
    // The backstop for an anchor that resolved to the wrong statement in a file
    // holding several. Parameters cannot catch it — two household locks bind
    // the same single `householdId` — so the locking clause is what identifies
    // which one was lifted.
    const message = shapeMismatch(statement, /FOR NO KEY UPDATE/, 'helpers.ts');

    expect(message).toMatch(/helpers\.ts/);
    expect(message).toContain('FOR NO KEY UPDATE');
  });
});

describe('parameterMismatch', () => {
  const statement: ShippedStatement = {
    text: 'SELECT 1 FROM x WHERE a = $1 AND b = $2',
    params: ['householdId', 'SystemRole.HouseholdOwner'],
  };

  it('passes silently when the shipped expressions are the ones the spec binds for', () => {
    expect(parameterMismatch(statement, ['householdId', 'SystemRole.HouseholdOwner'], 'x.ts')).toBeUndefined();
  });

  it('reports a reordering, which would otherwise bind the right values to the wrong places', () => {
    const message = parameterMismatch(statement, ['SystemRole.HouseholdOwner', 'householdId'], 'x.ts');

    expect(message).toMatch(/x\.ts/);
    expect(message).toContain('householdId');
  });

  it('reports an arity change', () => {
    expect(parameterMismatch(statement, ['householdId'], 'x.ts')).toMatch(/x\.ts/);
  });
});
