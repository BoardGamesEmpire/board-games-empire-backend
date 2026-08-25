import { extractPrismaSql, parameterMismatch, shapeMismatch, type ShippedStatement } from './shipped-sql';

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
describe('extractPrismaSql', () => {
  const wrap = (body: string, name = 'lockSomething'): string => `
    async function ${name}(tx) {
      const rows = await tx.$queryRaw(Prisma.sql\`${body}\`);

      return rows;
    }
  `;

  it('replaces each interpolation with a positional parameter, in order', () => {
    const statement = extractPrismaSql(
      wrap('SELECT id FROM households WHERE id = ${householdId} AND name = ${name}'),
      'households.ts',
    );

    expect(statement.text).toBe('SELECT id FROM households WHERE id = $1 AND name = $2');
  });

  it('returns the interpolated expressions verbatim, so a spec can pin what it binds', () => {
    const statement = extractPrismaSql(
      wrap('SELECT id FROM x WHERE a = ${householdId} AND b = ${SystemRole.HouseholdOwner}'),
      'x.ts',
    );

    expect(statement.params).toEqual(['householdId', 'SystemRole.HouseholdOwner']);
  });

  it('preserves the statement across lines, trimming only the surrounding indentation', () => {
    const statement = extractPrismaSql(
      wrap('\n      SELECT hr.household_member_id\n      FROM household_roles hr\n      FOR UPDATE OF hr\n    '),
      'members.ts',
    );

    expect(statement.text).toMatch(/^SELECT hr\.household_member_id/);
    expect(statement.text).toMatch(/FOR UPDATE OF hr$/);
    expect(statement.text).toContain('FROM household_roles hr');
  });

  it('handles braces inside an interpolation rather than ending the expression at the first one', () => {
    const statement = extractPrismaSql(wrap('SELECT ${pick({ a: 1 })} FROM x'), 'x.ts');

    expect(statement).toEqual<ShippedStatement>({ text: 'SELECT $1 FROM x', params: ['pick({ a: 1 })'] });
  });

  it('names the file when the source carries no Prisma.sql template', () => {
    expect(() => extractPrismaSql('const x = 1;', 'quiet.ts')).toThrow(/quiet\.ts/);
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

    expect(extractPrismaSql(two, 'two.ts', { after: 'lockSomething' }).text).toBe('SELECT 2 FROM not_this');
    expect(extractPrismaSql(two, 'two.ts', { after: 'lockFirstThing' }).text).toBe('SELECT 1 FROM only_this');
  });

  it('names the anchor it could not find, rather than falling back to the first template', () => {
    expect(() => extractPrismaSql(wrap('SELECT 1'), 'x.ts', { after: 'lockNothing' })).toThrow(/lockNothing/);
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

    expect(extractPrismaSql(source, 'pair.ts', { after: 'lockSecond' }).text).toBe('SELECT 2 FROM second');
  });

  it('refuses when the anchor appears only in prose', () => {
    const source = ['/**', ' * {@link lockElsewhere} lives in another file.', ' */', wrap('SELECT 1')].join('\n');

    expect(() => extractPrismaSql(source, 'x.ts', { after: 'lockElsewhere' })).toThrow(/only inside comments/);
  });

  it('refuses to guess when the source carries more than one template', () => {
    // Guessing is the failure mode worth designing against: picking the wrong
    // one of two statements produces a passing test for a statement nobody
    // asked about.
    const two = `${wrap('SELECT 1')}\n${wrap('SELECT 2')}`;

    expect(() => extractPrismaSql(two, 'two.ts')).toThrow(/2 Prisma\.sql templates/);
  });

  it('reports an unterminated template rather than returning the rest of the file', () => {
    expect(() => extractPrismaSql('const q = Prisma.sql`SELECT 1 FROM x', 'ragged.ts')).toThrow(/unterminated/i);
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
