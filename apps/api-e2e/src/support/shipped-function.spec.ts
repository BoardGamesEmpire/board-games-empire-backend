import {
  blankComments,
  extractBranchBody,
  extractFunctionBody,
  orderMismatch,
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
});
