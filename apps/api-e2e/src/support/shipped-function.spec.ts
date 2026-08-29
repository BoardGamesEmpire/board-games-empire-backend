import {
  anyOf,
  auditedWrites,
  blankComments,
  claimsIncludingDelegates,
  extractBranchBody,
  extractFunctionBody,
  fieldNamed,
  modelWrite,
  orderMismatch,
  relationInsert,
  relationLock,
  unconditionalClaimants,
  type OrderedStage,
} from './shipped-function';

/**
 * The lifter for facts that are neither a statement nor a template: the ORDER
 * a function takes its locks in.
 *
 * `shipped-sql.ts` covers everything expressible as a template. A lock order is
 * not — it lives in the sequence of calls a function makes, and the only place
 * it exists is the source text. So the same rule applies for the same reason: a
 * spec that restates the order asserts its own claim, and goes on passing after
 * the application stops taking it.
 *
 * Several cases below exist because the FIRST version of this module got them
 * wrong, and got them wrong quietly — returning a body that was not the named
 * function's while every test stayed green. They are kept as the record of what
 * moving to the TypeScript AST bought.
 */
describe('shipped-function', () => {
  describe('blankComments', () => {
    it('blanks a line comment without moving anything after it', () => {
      const source = 'const a = 1; // FOR UPDATE\nconst b = 2;';
      const blanked = blankComments(source);

      expect(blanked).toHaveLength(source.length);
      expect(blanked).not.toMatch(/FOR UPDATE/);
      expect(blanked.indexOf('const b')).toBe(source.indexOf('const b'));
    });

    it('blanks a block comment, including its newlines-worth of width', () => {
      const source = 'const a = 1;\n/* lockUserUnitScope\n   still comment */\nconst b = 2;';
      const blanked = blankComments(source);

      expect(blanked).toHaveLength(source.length);
      expect(blanked).not.toMatch(/lockUserUnitScope/);
      expect(blanked.indexOf('const b')).toBe(source.indexOf('const b'));
    });

    it('keeps string and template contents, which is where the SQL lives', () => {
      const source = 'const sql = `SELECT 1 FROM plugins FOR SHARE`; // not this one';
      const blanked = blankComments(source);

      expect(blanked).toMatch(/FOR SHARE/);
      expect(blanked).not.toMatch(/not this one/);
    });

    it('does not treat a comment marker inside a string as a comment', () => {
      const source = `const url = 'https://example.test/x'; const after = 1;`;

      expect(blankComments(source)).toContain('const after = 1;');
    });

    it('does not treat a comment marker inside a REGEX as a comment', () => {
      // The hand-rolled scanner read `//` here as a line comment and blanked
      // the rest of the line, which silently deleted whatever lock came after
      // it — a stage that stops matching used to read as "in order".
      const source = `const cleaned = slug.replace(/\\/\\//g, '-'); await lockHouseholdUnitScope(tx);`;
      const blanked = blankComments(source);

      expect(blanked).toContain('lockHouseholdUnitScope');
    });

    it('blanks a comment sitting alone before a closing brace', () => {
      // Trivia belongs to the token that follows it, and that token is the `}`
      // — not a node. A node-only walk left this one in the text, where a
      // mention of a lock SUPPLIED the match for a stage the path had stopped
      // taking and the pin answered "in order" about prose.
      const source = `
        function pathA(tx) {
          lockHouseholdUnitScope(tx);
          // this used to call suspendHouseholdUnit(tx)
        }
      `;

      expect(blankComments(source)).not.toMatch(/suspendHouseholdUnit/);
    });

    it('blanks a comment that is the whole body of a function', () => {
      expect(blankComments('function f() { /* suspendHouseholdUnit(tx) */ }')).not.toMatch(/suspendHouseholdUnit/);
    });

    it('treats an interpolation as code, so a comment inside one still blanks', () => {
      const source = 'const q = `id = ${/* here */ plugin.id}`;';
      const blanked = blankComments(source);

      expect(blanked).not.toMatch(/here/);
      expect(blanked).toMatch(/plugin\.id/);
    });
  });

  describe('extractFunctionBody', () => {
    const source = `
      class Service {
        /** Doc comment naming openHouseholdUnit, which must not be the anchor. */
        private async openHouseholdUnit(tx: Tx, householdId: string): Promise<Row | null> {
          await this.assertStillLiving(tx, plugin);
          await lockHouseholdUnitScope(tx, householdId, plugin.id);

          return tx.householdPlugin.findUnique({ where: { householdId } });
        }

        private async openUserUnit(tx: Tx, userId: string): Promise<Row | null> {
          await lockUserUnitScope(tx, userId, plugin.id);

          return tx.userPlugin.findUnique({ where: { userId } });
        }
      }
    `;

    it('returns the body between the braces, and nothing of the neighbour', () => {
      const { body } = extractFunctionBody(source, 'openHouseholdUnit', 'service.ts');

      expect(body).toMatch(/assertStillLiving/);
      expect(body).toMatch(/householdPlugin\.findUnique/);
      expect(body).not.toMatch(/openUserUnit/);
      expect(body).not.toMatch(/userPlugin\.findUnique/);
    });

    it('steps over a generic return type that carries its own braces', () => {
      const withObjectReturn = `
        class S {
          private async assertStillLiving(tx: Tx): Promise<{ scope: Scope; version: string }> {
            const rows = await tx.$queryRaw\`SELECT scope FROM plugins FOR SHARE\`;

            return rows[0];
          }
        }
      `;
      const { body } = extractFunctionBody(withObjectReturn, 'assertStillLiving', 'service.ts');

      expect(body).toMatch(/FOR SHARE/);
      expect(body).not.toMatch(/scope: Scope/);
    });

    it('steps over a BARE object-literal return type too', () => {
      // The brace matcher stepped over `Promise<{…}>` and not over `{…}`, so
      // this shape lifted the return TYPE as the body and pinned the order of
      // a type declaration.
      const bareObjectReturn = `
        function readUnit(id: string): { a: number } | null {
          return lockHouseholdUnitScope(id);
        }
      `;
      const { body } = extractFunctionBody(bareObjectReturn, 'readUnit', 'service.ts');

      expect(body).toMatch(/lockHouseholdUnitScope/);
      expect(body).not.toMatch(/a: number/);
    });

    it('is not fooled by braces inside a template literal', () => {
      const withTemplate = `
        class S {
          private async lockScope(tx: Tx): Promise<void> {
            const key = \`plugin_grant:household_unit:\${householdId}:\${pluginId}\`;

            await tx.$executeRaw\`SELECT pg_advisory_xact_lock(hashtextextended(\${key}, 0))\`;
          }
        }
      `;
      const { body } = extractFunctionBody(withTemplate, 'lockScope', 'lock.ts');

      expect(body).toMatch(/pg_advisory_xact_lock/);
      expect(body).toMatch(/plugin_grant:household_unit/);
    });

    it('is not fooled by a brace inside a REGEX literal', () => {
      // The brace matcher counted this one and ran off the end of the body,
      // swallowing the next function whole — so a pin judged two functions as
      // one and reported them in order.
      const withRegex = `
        function first(slug: string) {
          const trimmed = slug.replace(/[{]+$/, '');

          return lockHouseholdUnitScope(trimmed);
        }

        function second() {
          return neverInTheFirstBody();
        }
      `;
      const { body } = extractFunctionBody(withRegex, 'first', 'service.ts');

      expect(body).toMatch(/lockHouseholdUnitScope/);
      expect(body).not.toMatch(/neverInTheFirstBody/);
    });

    it('ignores a signature with no body, and takes the declaration that has one', () => {
      // An interface member with no trailing semicolon walked the brace matcher
      // out of the interface and into the class, so the lift returned the whole
      // class body and the pin judged every method at once.
      const withPort = `
        interface GrantPort {
          decide(input: Input): Promise<Output>
        }

        class GrantService {
          async decide(input: Input): Promise<Output> {
            return lockGrantRow(input);
          }

          async other(): Promise<void> {
            return neverInDecide();
          }
        }
      `;
      const { body } = extractFunctionBody(withPort, 'decide', 'service.ts');

      expect(body).toMatch(/lockGrantRow/);
      expect(body).not.toMatch(/neverInDecide/);
    });

    it('matches whole names, so a longer function does not answer for a shorter one', () => {
      const both = `
        function lockHouseholdUnitScope(tx) { return advisory(tx); }
        function lockHouseholdUnit(tx) { return rowLock(tx); }
      `;

      expect(extractFunctionBody(both, 'lockHouseholdUnit', 'lock.ts').body).toMatch(/rowLock/);
    });

    it('is not fooled by a call site above the declaration', () => {
      const callFirst = `
        const chosen = pickUnit(1) ? { a: 1 } : null;

        function pickUnit(n: number) {
          return lockHouseholdUnitScope(n);
        }
      `;
      const { body } = extractFunctionBody(callFirst, 'pickUnit', 'service.ts');

      expect(body).toMatch(/lockHouseholdUnitScope/);
      expect(body).not.toMatch(/a: 1/);
    });

    it('refuses a name it cannot find, naming the file', () => {
      expect(() => extractFunctionBody(source, 'openServerUnit', 'service.ts')).toThrow(
        /'openServerUnit'.*service\.ts/s,
      );
    });

    it('refuses a name that appears only in a comment', () => {
      const commentOnly = `
        /** Superseded by openServerUnit, which is not declared here. */
        function openUserUnit(tx) {
          return lockUserUnitScope(tx);
        }
      `;

      expect(() => extractFunctionBody(commentOnly, 'openServerUnit', 'service.ts')).toThrow(/'openServerUnit'/);
    });

    it('refuses a name declared twice with a body, rather than picking one', () => {
      // Two classes in one file. Either body is a defensible answer, which is
      // exactly why this module must not choose.
      const twice = `
        class A {
          async decide() { return first(); }
        }
        class B {
          async decide() { return second(); }
        }
      `;

      expect(() => extractFunctionBody(twice, 'decide', 'service.ts')).toThrow(/declared 2 times/);
    });
  });

  describe('extractBranchBody', () => {
    const source = `
      class Service {
        async decide(input: Input): Promise<void> {
          await tx.pluginGrant.upsert({});

          if (input.status === Denied && check.required) {
            await this.suspendHouseholdUnit(tx);
          }

          if (input.status === Granted && input.scopeType === Scope.User) {
            await lockUserUnitScope(tx);
            await tx.userPlugin.upsert({});
          }
        }
      }
    `;

    it('returns only the branch whose condition matches', () => {
      const { body } = extractBranchBody(source, 'decide', /Granted && input\.scopeType/, 'service.ts');

      expect(body).toMatch(/lockUserUnitScope/);
      expect(body).toMatch(/userPlugin\.upsert/);
      expect(body).not.toMatch(/suspendHouseholdUnit/);
      expect(body).not.toMatch(/pluginGrant\.upsert/);
    });

    it('scopes the order to that branch, which the whole body cannot', () => {
      // Two independent branches, and the mirror runs first — so over the whole
      // body the mirror's unit work dates the anchor branch's key, and the
      // claim 'key before unit row' is unjudgeable there in BOTH directions.
      const stages: readonly OrderedStage[] = [
        { name: 'advisory key', pattern: /lockUserUnitScope\(/ },
        { name: 'unit row', pattern: /userPlugin\.upsert\(|suspendHouseholdUnit\(/ },
      ];

      // Correct code, and the whole body still cries foul: a false alarm, which
      // is why the entry over the whole body cannot make this claim at all.
      expect(orderMismatch(extractFunctionBody(source, 'decide', 's.ts').body, stages, 'decide')).toMatch(
        /takes 'unit row' before 'advisory key'/,
      );

      // Scoped to the branch, the same claim is judgeable — and true.
      expect(
        orderMismatch(
          extractBranchBody(source, 'decide', /Granted && input\.scopeType/, 's.ts').body,
          stages,
          'decide',
        ),
      ).toBeUndefined();

      // And false when the anchor is created ahead of its key, which is the
      // inversion that deadlocks against the mirror pass.
      const inverted = source.replace(
        'await lockUserUnitScope(tx);\n            await tx.userPlugin.upsert({});',
        'await tx.userPlugin.upsert({});\n            await lockUserUnitScope(tx);',
      );

      expect(
        orderMismatch(
          extractBranchBody(inverted, 'decide', /Granted && input\.scopeType/, 's.ts').body,
          stages,
          'decide',
        ),
      ).toMatch(/takes 'unit row' before 'advisory key'/);
    });

    it('finds a branch inside a transaction callback, which is where the real ones live', () => {
      // Deliberate, and load-bearing. Every service pinned by `lock-order.ts`
      // does its work inside `db.$transaction(async (tx) => …)`, so the branch
      // that takes the locks is nested in a function expression rather than
      // sitting directly in the method body. A traversal that stopped at
      // nested functions — a reasonable-sounding way to keep a stray callback
      // from answering for the path — would find nothing here at all.
      //
      // Two matching `if`s are refused rather than silently chosen. ONE is
      // not, and that is the honest residual: if the real branch were
      // restructured away and some unrelated callback happened to test the
      // same condition, its body would answer for the path.
      //
      // Admitting only the transaction callback does not close that. The
      // `.filter` and `.map` arrows in the real `decide` sit INSIDE the
      // transaction callback, so any rule that still reaches the branch
      // reaches them too — and teaching a general source lifter what a Prisma
      // transaction is would couple it to the one caller it is about to stop
      // being for. What actually bounds it is a condition specific enough that
      // an `if` matching it IS the branch wherever it moved to, and the stage
      // assertions the lifted body still has to satisfy afterwards.
      const wrapped = `
        class Service {
          async decide(input: Input): Promise<void> {
            return this.db.$transaction(async (tx) => {
              if (input.status === Granted && input.scopeType === Scope.User) {
                await lockUserUnitScope(tx);
              }
            });
          }
        }
      `;

      expect(extractBranchBody(wrapped, 'decide', /Granted && input\.scopeType/, 'service.ts').body).toMatch(
        /lockUserUnitScope/,
      );
    });

    it('refuses a condition no branch tests', () => {
      expect(() => extractBranchBody(source, 'decide', /Revoked/, 'service.ts')).toThrow(/No branch of 'decide'/);
    });

    it('names the branch by its condition, not by what it contains', () => {
      // Matching on the lock would make the pin agree with whatever it found,
      // so the CONDITION has to be what a failure reports. Asserting only that
      // the function name is in there passes for a name that is the function
      // name and nothing else, which is the whole thing this case denies.
      const condition = /Granted && input\.scopeType/;
      const { name } = extractBranchBody(source, 'decide', condition, 'service.ts');

      expect(name).toContain('decide');
      expect(name).toContain(String(condition));
      expect(name).not.toMatch(/lockUserUnitScope|userPlugin/);
    });

    it('refuses a name that is not declared, rather than searching the file for ifs', () => {
      expect(() => extractBranchBody(source, 'settle', /Granted/, 'service.ts')).toThrow(
        /Could not find a declaration of 'settle'/,
      );
    });

    it('refuses an ambiguous name, rather than branching inside one of them', () => {
      const twice = `
        class A { async decide(i: I) { if (i.x) { await one(); } } }
        class B { async decide(i: I) { if (i.x) { await two(); } } }
      `;

      expect(() => extractBranchBody(twice, 'decide', /i\.x/, 'service.ts')).toThrow(/declared 2 times/);
    });

    it('refuses a stateful condition, which would hide an ambiguous branch', () => {
      // `test` advances `lastIndex` on a global or sticky pattern, so the
      // second of two matching branches reports false. Left unguarded, the
      // ambiguity refusal below never fires and the pin silently takes the
      // first branch — the flag doing what the module refuses to do.
      const ambiguous = `
        class S {
          async decide(i: I) {
            if (i.status === Granted) { await first(); }
            if (i.status === Granted) { await second(); }
          }
        }
      `;

      expect(() => extractBranchBody(ambiguous, 'decide', /status === Granted/, 's.ts')).toThrow(/2 branches/);

      for (const stateful of [/status === Granted/g, /status === Granted/y]) {
        expect(() => extractBranchBody(ambiguous, 'decide', stateful, 's.ts')).toThrow(/'g' or 'y' flag/);
      }
    });
  });

  describe('orderMismatch', () => {
    const STAGES: readonly OrderedStage[] = [
      { name: 'plugin row', pattern: /assertStillLiving\(/ },
      { name: 'advisory key', pattern: /lockHouseholdUnitScope\(/ },
      { name: 'unit row', pattern: /lockHouseholdUnit\(/ },
    ];

    it('passes a body that takes the stages in order', () => {
      const body = `
        await this.assertStillLiving(tx);
        await lockHouseholdUnitScope(tx);
        await this.lockHouseholdUnit(tx);
      `;

      expect(orderMismatch(body, STAGES, 'openHouseholdUnit')).toBeUndefined();
    });

    it('fails a body that stopped taking one of the stages it claims', () => {
      // The hole this module shipped with: skipping the absent stage left one
      // match, no pair to compare, and "in order" as the answer. Every 2-stage
      // path was one rename from asserting nothing.
      const body = `
        await this.assertStillLiving(tx);
        await this.lockHouseholdUnit(tx);
      `;
      const message = orderMismatch(body, STAGES, 'openHouseholdUnit');

      expect(message).toMatch(/no longer takes 'advisory key'/);
      expect(message).toMatch(/renamed/);
    });

    it('names every stage that went missing, not just the first', () => {
      const message = orderMismatch('await this.assertStillLiving(tx);', STAGES, 'openHouseholdUnit');

      expect(message).toMatch(/'advisory key'/);
      expect(message).toMatch(/'unit row'/);
    });

    it('checks only the stages a path claims, so a subset is a legitimate claim', () => {
      // Not every writer takes every lock: `decide()` never locks the plugin
      // row. What is refused is claiming a stage and not taking it.
      const body = `
        await lockHouseholdUnitScope(tx);
        await this.lockHouseholdUnit(tx);
      `;

      expect(orderMismatch(body, STAGES.slice(1), 'decide')).toBeUndefined();
    });

    it('reports a swapped pair, naming both stages and the path', () => {
      // The cycle inverted in PR #363's review, in miniature.
      const body = `
        await lockHouseholdUnitScope(tx);
        await this.assertStillLiving(tx);
        await this.lockHouseholdUnit(tx);
      `;
      const message = orderMismatch(body, STAGES, 'openHouseholdUnit');

      expect(message).toMatch(/openHouseholdUnit/);
      expect(message).toMatch(/plugin row/);
      expect(message).toMatch(/advisory key/);
    });

    it('judges by first occurrence, so a later re-read cannot excuse an early take', () => {
      const body = `
        await lockHouseholdUnitScope(tx);
        await this.assertStillLiving(tx);
        await this.lockHouseholdUnit(tx);
        await this.assertStillLiving(tx);
      `;

      expect(orderMismatch(body, STAGES, 'openHouseholdUnit')).toMatch(/plugin row/);
    });
  });

  describe('relationLock', () => {
    /**
     * The boundary these cases defend was tightened three times in review, each
     * time across three hand-written copies. It is one function now, so this is
     * where the rule is tested and a stage spec only has to show it is wired to
     * it.
     */
    const pluginRow = relationLock('plugins', 'FOR SHARE');

    it('matches the lock it is about', () => {
      expect('SELECT uninstalled_at, scope FROM plugins WHERE id = $1 FOR SHARE').toMatch(pluginRow);
      expect('SELECT id\n FROM plugins\n WHERE id = $1\n FOR SHARE').toMatch(pluginRow);
    });

    it('does not match a lock on a different relation', () => {
      // The failure this whole builder exists for. Order is judged by FIRST
      // occurrence, so a stage matching a statement it did not mean does not
      // merely over-match — it dates the stage to that statement, and a lock
      // genuinely taken later reports as held early.
      expect('SELECT id FROM households WHERE id = $1 FOR SHARE').not.toMatch(pluginRow);
    });

    it('ends the relation name where the identifier ends, not at any non-word byte', () => {
      // `\b` would accept all three of these. `$` is a legal Postgres
      // identifier character, and a trailing `.` makes the name a SCHEMA, so
      // `plugins.audit` is a lock on some other table wearing this one's name.
      expect('SELECT id FROM plugins_archive WHERE id = $1 FOR SHARE').not.toMatch(pluginRow);
      expect('SELECT id FROM plugins$archive WHERE id = $1 FOR SHARE').not.toMatch(pluginRow);
      expect('SELECT id FROM plugins.audit WHERE id = $1 FOR SHARE').not.toMatch(pluginRow);
    });

    it('keeps a form an enumeration of delimiters would have dropped', () => {
      // The reason the guard says where the name ENDS rather than listing what
      // may follow it. A list has to have thought of every delimiter; this one
      // was not on the obvious list, and dropping it silently stops the stage
      // matching a real lock.
      expect('SELECT id FROM (SELECT id FROM plugins) x WHERE id = $1 FOR SHARE').toMatch(pluginRow);
    });

    it('does not match the same relation under a different mode', () => {
      // `FOR SHARE` and `FOR KEY SHARE` are different locks against different
      // conflict sets, and the stage claims one of them.
      expect('SELECT id FROM plugins WHERE id = $1 FOR KEY SHARE').not.toMatch(pluginRow);
      expect('SELECT id FROM plugins WHERE id = $1 FOR KEY SHARE').toMatch(relationLock('plugins', 'FOR KEY SHARE'));
    });

    it('matches either relation when a stage is taken on more than one', () => {
      const unitRow = relationLock(['household_plugins', 'user_plugins'], 'FOR UPDATE');

      expect('SELECT id FROM household_plugins WHERE id = $1 FOR UPDATE').toMatch(unitRow);
      expect('SELECT id FROM user_plugins WHERE id = $1 FOR UPDATE').toMatch(unitRow);
      expect('SELECT id FROM plugins WHERE id = $1 FOR UPDATE').not.toMatch(unitRow);
    });

    it('refuses a name that is regex rather than a relation', () => {
      // This builds a pattern, so syntax in the name WIDENS it instead of
      // failing — `plugins|households` reads as one table and matches two,
      // which is the silent answer every refusal in this module exists to
      // prevent.
      expect(() => relationLock('plugins|households', 'FOR SHARE')).toThrow(/not a plain relation name/);
      expect(() => relationLock(['plugins', 'plugin.*'], 'FOR UPDATE')).toThrow(/not a plain relation name/);
    });

    it('refuses naming no relation at all', () => {
      expect(() => relationLock([], 'FOR UPDATE')).toThrow(/name the table/);
    });
  });

  describe('anyOf', () => {
    it('matches any alternative, and nothing it was not given', () => {
      const stage = anyOf(/assertStillLiving\(/, relationLock('plugins', 'FOR SHARE'));

      expect('await this.assertStillLiving(tx);').toMatch(stage);
      expect('FROM plugins WHERE id = $1 FOR SHARE').toMatch(stage);
      expect('await this.lockHouseholdUnit(tx);').not.toMatch(stage);
    });

    it('refuses combining nothing, which would match every body at offset 0', () => {
      // The worst shape a stage pattern can take, and it is silent twice over.
      // Joining no alternatives gives `/(?:)/`, which `search` answers with 0
      // for any body — so `orderMismatch` never reports the stage missing, and
      // dates it before every stage that really was taken. A path that stopped
      // taking the lock would read as taking it first.
      expect(() => anyOf()).toThrow(/matches every body at offset 0/);
    });

    it('refuses flags rather than dropping them', () => {
      // Combining sources silently discards flags, and `g` is the one that
      // matters: it makes `test` stateful, so a stage pattern checked against
      // many bodies would report false on every second one. That is a pin
      // passing, not a pin failing.
      expect(() => anyOf(/assertStillLiving\(/g)).toThrow(/carry flags/);
    });
  });

  /**
   * The half of this module that is about locks nobody wrote (#399).
   *
   * Every case here is really one question asked twice: does the check still
   * FAIL on the shape it exists for? A dominance analysis that answered "yes,
   * claimed" to everything would pass the whole plugin runtime silently, which
   * is precisely the state #398 shipped in — both suites green over a live
   * deadlock. So the passing cases are the smaller half; the ones that matter
   * are the shapes that must stay red.
   */
  describe('auditedWrites', () => {
    const WRITE = [{ pattern: /pluginGrant\.create$/ }];
    const CLAIM = /FOR SHARE/;

    const audit = (body: string) => auditedWrites(`async function persist(tx) {${body}}`, 'persist.ts', WRITE, CLAIM);

    it('finds the write and calls it claimed when the claim runs before it', () => {
      const [site] = audit(`
        await tx.$queryRaw\`SELECT id FROM plugins WHERE id = $1 FOR SHARE\`;
        await tx.pluginGrant.create({ data });
      `);

      expect(site).toMatchObject({ enclosing: 'persist', claimed: true });
      expect(site?.text).toContain('pluginGrant.create');
    });

    it('reports the write when the claim comes after it', () => {
      // The #398 shape exactly: the transaction does take the plugin row, and
      // takes it too late, so the FK's own FOR KEY SHARE has already landed
      // after the child tuple. A presence check passes this.
      const [site] = audit(`
        await tx.pluginGrant.create({ data });
        await tx.$queryRaw\`SELECT id FROM plugins WHERE id = $1 FOR SHARE\`;
      `);

      expect(site?.claimed).toBe(false);
    });

    it('reports the write when only ONE arm of a branch claims', () => {
      // `plugin-installer.service.ts` in miniature, and the reason this is
      // dominance rather than first occurrence. The claim is real on one path
      // and absent on the other; a search for the earliest match finds it and
      // says nothing about the path that has no lock in it.
      const [site] = audit(`
        if (existing === null) {
          plugin = await tx.plugin.create({ data });
        } else {
          await tx.$queryRaw\`SELECT id FROM plugins WHERE id = $1 FOR SHARE\`;
        }

        await tx.pluginGrant.create({ data });
      `);

      expect(site?.claimed).toBe(false);
    });

    it('accepts a branch that claims on both arms', () => {
      const [site] = audit(`
        if (existing === null) {
          await tx.$queryRaw\`SELECT id FROM plugins WHERE id = $1 FOR SHARE\`;
        } else {
          await tx.$queryRaw\`SELECT id FROM plugins WHERE id = $2 FOR SHARE\`;
        }

        await tx.pluginGrant.create({ data });
      `);

      expect(site?.claimed).toBe(true);
    });

    it('does not accept a claim whose failure a catch swallows', () => {
      // The reasoning that makes a bare `try` safe — if the claim throws, the
      // write below is not reached either — stops being true the moment there
      // is a catch. The throw is swallowed, execution walks on to the write
      // holding no lock, and the FK's own FOR KEY SHARE lands last: #398,
      // exactly.
      const [site] = audit(`
        try {
          await tx.$queryRaw\`SELECT id FROM plugins WHERE id = $1 FOR SHARE\`;
        } catch {
          // best effort
        }

        await tx.pluginGrant.create({ data });
      `);

      expect(site?.claimed).toBe(false);
    });

    it('accepts a try whose catch claims as well', () => {
      const [site] = audit(`
        try {
          await tx.$queryRaw\`SELECT id FROM plugins WHERE id = $1 FOR SHARE\`;
        } catch {
          await tx.$queryRaw\`SELECT id FROM plugins WHERE id = $2 FOR SHARE\`;
        }

        await tx.pluginGrant.create({ data });
      `);

      expect(site?.claimed).toBe(true);
    });

    it('accepts a try with no catch, where a throw skips the write too', () => {
      const [site] = audit(`
        try {
          await tx.$queryRaw\`SELECT id FROM plugins WHERE id = $1 FOR SHARE\`;
        } finally {
          release();
        }

        await tx.pluginGrant.create({ data });
      `);

      expect(site?.claimed).toBe(true);
    });

    it('is not disturbed by a guard clause that returns before the claim', () => {
      // Dominance and delegate promotion ask different questions of the same
      // rule, and this is where they part. A path taking the early return never
      // reaches the write, so every path that DOES reach it took the lock — the
      // claim dominates, and reporting otherwise would be a false failure.
      //
      // Promotion is the strict one, because a delegate's caller carries on
      // past it: see `unconditionalClaimants` below.
      const [site] = audit(`
        if (plugin.scope !== 'Household') {
          return;
        }

        await tx.$queryRaw\`SELECT id FROM plugins WHERE id = $1 FOR SHARE\`;
        await tx.pluginGrant.create({ data });
      `);

      expect(site?.claimed).toBe(true);
    });

    it('does not accept a claim taken inside a loop', () => {
      // A loop over an empty list takes nothing, and an empty list is not an
      // exotic input — `serverChecks` is empty for a manifest declaring no
      // server-scope permissions.
      const [site] = audit(`
        for (const check of checks) {
          await tx.$queryRaw\`SELECT id FROM plugins WHERE id = $1 FOR SHARE\`;
        }

        await tx.pluginGrant.create({ data });
      `);

      expect(site?.claimed).toBe(false);
    });

    it('carries the claim into a write nested inside branches and loops', () => {
      // The other direction, and the reason the walk goes out level by level
      // rather than comparing offsets: a write buried three constructs deep is
      // still dominated by the statement that opened the transaction.
      const [site] = audit(`
        await tx.$queryRaw\`SELECT id FROM plugins WHERE id = $1 FOR SHARE\`;

        if (seeded) {
          for (const check of checks) {
            await tx.pluginGrant.create({ data: check });
          }
        }
      `);

      expect(site?.claimed).toBe(true);
    });

    it('does not let a claim inside a nested function answer for a write outside it', () => {
      // Whether a callback runs — and in whose transaction — is not something a
      // reader of source knows. Counting one would let a claim in a callback
      // defined earlier in the body cover a write in a different transaction.
      const [site] = audit(`
        const claim = async () => {
          await tx.$queryRaw\`SELECT id FROM plugins WHERE id = $1 FOR SHARE\`;
        };

        await tx.pluginGrant.create({ data });
      `);

      expect(site?.claimed).toBe(false);
    });

    it('scopes the claim to the innermost function, not the enclosing method', () => {
      // A claim outside the transaction callback is a claim in a different
      // transaction, or in none. Widening the scope to the method would let it
      // answer for every write inside the callback.
      const source = `
        class Installer {
          async persist(tx) {
            await this.db.$queryRaw\`SELECT id FROM plugins WHERE id = $1 FOR SHARE\`;

            return this.db.$transaction(async (tx) => {
              await tx.pluginGrant.create({ data });
            });
          }
        }
      `;
      const [site] = auditedWrites(source, 'installer.ts', WRITE, CLAIM);

      expect(site).toMatchObject({ enclosing: 'persist', claimed: false });
    });

    it('names a class property arrow rather than reporting the site as top level', () => {
      // `<top level>` matches no exemption's `enclosing`, so a site labelled
      // that way can never be explained — and a pin written for it would name a
      // function that does not appear in the source.
      const source = `
        class Grants {
          private readonly persistGrants = async (tx) => {
            await tx.pluginGrant.create({ data });
          };
        }
      `;
      const [site] = auditedWrites(source, 'grants.ts', WRITE, CLAIM);

      expect(site?.enclosing).toBe('persistGrants');
    });

    it('applies an argument guard, so an update counts only when it writes the key', () => {
      // Postgres skips the RI check on an UPDATE whose key columns are
      // unchanged, so only a re-parenting update takes the implied lock.
      // Matching every child update instead would report the dormancy writes
      // and every `updateMany({ enabled })` in the tree — noise standing where
      // a real finding would appear.
      const shapes = [
        { pattern: /pluginGrant\.updateMany$/, withArguments: fieldNamed(['pluginId']), argumentProperty: 'data' },
      ];
      const scan = (body: string) => auditedWrites(`async function f(tx) {${body}}`, 'f.ts', shapes, /FOR SHARE/);

      expect(scan('await tx.pluginGrant.updateMany({ where, data: { pluginId: next } });')).toHaveLength(1);
      expect(scan('await tx.pluginGrant.updateMany({ where, data: { status } });')).toHaveLength(0);
    });

    it('asks the guard about `data` alone, not the key the row is addressed by', () => {
      // Activation's grant re-stamp, in miniature: `where` names the FK because
      // the row's unique key contains it, and `data` rewrites four other
      // columns. Judging the whole call reports this — and with it every keyed
      // child update in the tree, which is all of them.
      const shapes = [
        { pattern: /pluginGrant\.update$/, withArguments: fieldNamed(['pluginId']), argumentProperty: 'data' },
      ];
      const scan = (body: string) => auditedWrites(`async function f(tx) {${body}}`, 'f.ts', shapes, /FOR SHARE/);

      expect(
        scan('await tx.pluginGrant.update({ where: { pluginId_slug: { pluginId } }, data: { decidedAt } });'),
      ).toHaveLength(0);
    });

    it('reports the write when the guarded payload cannot be enumerated', () => {
      // A guard that narrows can only CLEAR a site when it sees the whole key
      // set. Each of these hides the keys somewhere else, and the earlier
      // whole-call fallback quietly cleared the first three: the argument text
      // names no FK column, so the write vanished from the audit with no site
      // and no exemption — the silent-clean-tree failure this module refuses
      // everywhere else.
      const shapes = [
        { pattern: /pluginGrant\.update$/, withArguments: fieldNamed(['pluginId']), argumentProperty: 'data' },
      ];
      const scan = (body: string) => auditedWrites(`async function f(tx) {${body}}`, 'f.ts', shapes, /x/);

      expect(scan('const data = { pluginId: n }; await tx.pluginGrant.update({ where, data });')).toHaveLength(1);
      expect(scan('await tx.pluginGrant.update({ where, data: payload });')).toHaveLength(1);
      expect(scan('await tx.pluginGrant.update({ where, data: { ...payload } });')).toHaveLength(1);
      expect(scan('await tx.pluginGrant.update(args);')).toHaveLength(1);
      // And still settles the one it CAN read.
      expect(scan('await tx.pluginGrant.update({ where, data: { decidedAt } });')).toHaveLength(0);
    });

    it('refuses a scan that looks for no write shape at all', () => {
      // The empty-list failure this module refuses everywhere else: no shapes
      // means no sites means no violations, reported as a clean tree.
      expect(() => auditedWrites('', 'x.ts', [], /a/)).toThrow(/reads exactly like a clean tree/);
    });

    it('reports one site per write, not one per call that contains it', () => {
      // Matching whole call texts would report `seededGrants.push(...)` as a
      // grant write too, and two reports of one site is two exemptions to
      // write and one of them stale from the day it lands.
      const sites = audit('seededGrants.push(await tx.pluginGrant.create({ data }));');

      expect(sites).toHaveLength(1);
    });

    it('refuses a stateful pattern rather than answering differently each call', () => {
      // `g` makes `test` advance `lastIndex`, so the same body reports claimed,
      // then unclaimed, then claimed. A scan whose answer depends on how many
      // times it has run is worse than no scan.
      expect(() => auditedWrites('', 'x.ts', [{ pattern: /a/g }], /b/)).toThrow(/write pattern/);
      expect(() => auditedWrites('', 'x.ts', [{ pattern: /a/ }], /b/y)).toThrow(/claim pattern/);
    });
  });

  describe('claimsIncludingDelegates', () => {
    const CLAIM = /FOR SHARE/;

    it('recognises a call to a function that claims on every path', () => {
      // The shape every unit path uses: nothing in `enableHousehold` looks like
      // a lock, and it is holding one. Without this the check reports a false
      // failure on the most-travelled compliant path in the tree.
      const source = `
        async function assertStillLiving(tx) {
          await tx.$queryRaw\`SELECT id FROM plugins WHERE id = $1 FOR SHARE\`;
        }

        async function openHouseholdUnit(tx) {
          await assertStillLiving(tx);
          await lockHouseholdUnitScope(tx);
        }
      `;
      const claims = claimsIncludingDelegates(source, 'units.ts', CLAIM);

      expect('await this.openHouseholdUnit(tx, plugin);').toMatch(claims);
      expect('await this.lockHouseholdUnitScope(tx);').not.toMatch(claims);
    });

    it('does not promote a function that only claims on one path', () => {
      const source = `
        async function maybeClaim(tx) {
          if (needed) {
            await tx.$queryRaw\`SELECT id FROM plugins WHERE id = $1 FOR SHARE\`;
          }
        }
      `;

      expect('await maybeClaim(tx);').not.toMatch(claimsIncludingDelegates(source, 'units.ts', CLAIM));
    });

    it('recognises a delegate whose name carries a `$`', () => {
      // Two bugs in one shape, both silent: `$` is a regex anchor (so the
      // interpolated name matches nothing) and `$` is not a word character (so
      // a leading `\b` demands a word character before it, which `this.` is
      // not). The delegate would be found and then quietly never match.
      const source = `
        async function $claimPluginRow(tx) {
          await tx.$queryRaw\`SELECT id FROM plugins WHERE id = $1 FOR SHARE\`;
        }
      `;

      expect('await this.$claimPluginRow(tx);').toMatch(claimsIncludingDelegates(source, 'd.ts', CLAIM));
    });

    it('follows a delegate through more than one hop', () => {
      // Resolved to a fixpoint rather than one level deep, so a third link
      // added later does not turn a compliant path red for the wrong reason.
      const source = `
        async function innermost(tx) {
          await tx.$queryRaw\`SELECT id FROM plugins WHERE id = $1 FOR SHARE\`;
        }

        async function middle(tx) {
          await innermost(tx);
        }

        async function outer(tx) {
          await middle(tx);
        }
      `;

      expect('await outer(tx);').toMatch(claimsIncludingDelegates(source, 'units.ts', CLAIM));
    });
  });

  describe('unconditionalClaimants', () => {
    it('does not promote a helper whose guard clause returns before the lock', () => {
      // The shape this rule exists for. A delegate answers for EVERY caller's
      // child write, so crediting one that can return without its lock hands
      // the #398 deadlock a helper's name to hide behind.
      const source = `
        async function claimForHousehold(tx, plugin) {
          if (plugin.scope !== 'Household') {
            return;
          }
          await tx.$queryRaw\`SELECT id FROM plugins WHERE id = $1 FOR SHARE\`;
        }
      `;

      expect(unconditionalClaimants(source, 'g.ts', /FOR SHARE/)).toEqual([]);
    });

    it('promotes a helper written as a class property arrow', () => {
      // `private readonly claim = async (tx) => {…}` is a method spelled the
      // other way. Missing it costs a false failure on the caller; missing the
      // same shape in `enclosingName` costs a site labelled `<top level>`,
      // which no exemption can name.
      const source = `
        class Units {
          private readonly claimIt = async (tx) => {
            await tx.$queryRaw\`SELECT id FROM plugins WHERE id = $1 FOR SHARE\`;
          };
        }
      `;

      expect(unconditionalClaimants(source, 'u.ts', /FOR SHARE/)).toEqual(['claimIt']);
    });

    it('does not count a claim that only runs inside a callback', () => {
      // `enableHousehold` takes its lock inside a `$transaction` arrow. Counting
      // that would make the METHOD a delegate, so a caller could claim through
      // it without being in its transaction at all.
      const source = `
        async function enableHousehold(input) {
          return this.db.$transaction(async (tx) => {
            await tx.$queryRaw\`SELECT id FROM plugins WHERE id = $1 FOR SHARE\`;
          });
        }
      `;

      expect(unconditionalClaimants(source, 'units.ts', /FOR SHARE/)).toEqual([]);
    });
  });

  describe('modelWrite', () => {
    it('matches the callee it names, and nothing that merely contains it', () => {
      const write = modelWrite(['pluginGrant', 'userPlugin'], ['create', 'upsert']);

      expect('tx.pluginGrant.create').toMatch(write);
      expect('pluginGrant.upsert').toMatch(write);
      // The tail anchor: `create` must not stand in for a method whose name
      // merely starts with it. Which cuts BOTH ways — `createManyAndReturn` is a
      // real Prisma 7 insert, and a list that forgets it does not near-miss, it
      // matches nothing and reports the tree clean. It is named in
      // FK_CHILD_INSERT_METHODS for that reason.
      expect('tx.pluginGrant.createIfAbsent').not.toMatch(write);
      expect('tx.pluginPermission.create').not.toMatch(write);
      // The head alternation: a name ENDING in an accessor is not that accessor.
      expect('tx.stalePluginGrant.create').not.toMatch(write);
    });

    it('matches a chain the formatter wrapped across lines', () => {
      // A callee is lifted verbatim, so a wrapped chain arrives carrying its
      // newline and indent. Without whitespace around the separator that write
      // matches no shape at all — no site, no finding, clean tree — and whether
      // a chain wraps is a decision the formatter makes on line length.
      const write = modelWrite(['pluginGrant'], ['create']);

      expect('tx.pluginGrant\n        .create').toMatch(write);
      expect('tx.pluginGrant.create').toMatch(write);
    });

    it('escapes a `$` in a name instead of building a pattern that matches nothing', () => {
      // `$` is a legal identifier character AND a regex anchor, so the naive
      // interpolation yields `/…(?:$queryRaw)…/` — an assertion, not a literal,
      // which matches no text at all. In a write pattern that is a scan
      // reporting a clean tree; the repo is full of `$`-prefixed Prisma names.
      const write = modelWrite(['$extended'], ['create']);

      expect('tx.$extended.create').toMatch(write);
      expect(fieldNamed(['$pluginId']).test('data: { $pluginId: next }')).toBe(true);
    });

    it('refuses regex in an accessor rather than widening what it matches', () => {
      expect(() => modelWrite(['pluginGrant|plugin'], ['create'])).toThrow(/not a plain identifier/);
      expect(() => modelWrite([], ['create'])).toThrow(/matches nothing/);
    });
  });

  describe('relationInsert', () => {
    it('holds the table name to the same boundary a lock does', () => {
      const insert = relationInsert(['plugin_grants']);

      expect('INSERT INTO plugin_grants (id) VALUES ($1)').toMatch(insert);
      expect('INSERT  INTO  plugin_grants (id)').toMatch(insert);
      // The rule `relationLock` states once: a prefix match is a different
      // table, and a trailing dot makes the name a schema.
      expect('INSERT INTO plugin_grants_archive (id)').not.toMatch(insert);
      expect('INSERT INTO plugin_grants.audit (id)').not.toMatch(insert);
    });
  });
});
