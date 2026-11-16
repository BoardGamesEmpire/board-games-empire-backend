'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkQueueHashTags, findQueueNames, hasHashTag, hashTagOf } = require('./check');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/**
 * The environment without git's own variables. Inside a git hook they point at
 * the real repository, and the fixtures below would be staged there.
 */
const ENV_WITHOUT_GIT = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));

const file = (filePath, text) => ({ path: filePath, text });

describe('hasHashTag (#462)', () => {
  it.each([
    ['{bge.mail.delivery}', true],
    ['bull:{a}:x', true],
    ['mail-delivery', false],
    ['{}', false],
    ['}{a', false],
  ])("%s: has a hash tag is %s, by Redis Cluster's braces rule (#462)", (name, expected) => {
    expect(hasHashTag(name)).toBe(expected);
  });
});

describe('hashTagOf (#462)', () => {
  it.each([
    ['{bge.games}.import', 'bge.games'],
    ['{bge.mail.delivery}', 'bge.mail.delivery'],
    ['mail-delivery', null],
    ['{}', null],
  ])('%s has hash tag %s', (name, expected) => {
    expect(hashTagOf(name)).toBe(expected);
  });
});

describe('findQueueNames (#462)', () => {
  it('resolves a const declared in another file', () => {
    const { sites, unresolved } = findQueueNames([
      file('libs/a/mail.module.ts', `BullModule.registerQueue({ name: MAIL });`),
      file('libs/a/constants.ts', `export const MAIL = 'mail-delivery';`),
    ]);

    expect(unresolved).toEqual([]);
    expect(sites).toEqual([
      {
        file: 'libs/a/mail.module.ts',
        line: 1,
        name: 'mail-delivery',
        definedAt: { file: 'libs/a/constants.ts', line: 1 },
      },
    ]);
  });

  it('resolves a string enum member used by @Processor', () => {
    const { sites, unresolved } = findQueueNames([
      file('libs/a/p.ts', `@Processor(QueueNames.GamesImport)\nexport class P {}`),
      file('libs/a/q.ts', `export enum QueueNames {\n  GamesImport = '{bge.games}.import',\n}`),
    ]);

    expect(unresolved).toEqual([]);
    expect(sites).toEqual([expect.objectContaining({ name: '{bge.games}.import', line: 1 })]);
  });

  it('resolves a flow child queueName that is an enum member', () => {
    const { sites } = findQueueNames([
      file('libs/a/flow.ts', `const f = { queueName: QueueNames.GatewayFetch };`),
      file('libs/a/q.ts', `export enum QueueNames { GatewayFetch = '{bge.games}.fetch' }`),
    ]);

    expect(sites).toEqual([expect.objectContaining({ name: '{bge.games}.fetch' })]);
  });

  it('resolves a member of a const object, @InjectQueue and constructors', () => {
    const { sites, unresolved } = findQueueNames([
      file(
        'libs/a/use.ts',
        [
          `class S { constructor(@InjectQueue(Q.mail) q: Queue) {} }`,
          `const a = new Queue(Q.mail);`,
          `const b = new Worker('{x.y}', async () => {});`,
          `const c = new QueueEvents(Q.mail);`,
        ].join('\n'),
      ),
      file('libs/a/q.ts', `export const Q = { mail: 'mail' } as const;`),
    ]);

    expect(unresolved).toEqual([]);
    expect(sites.map(({ name }) => name)).toEqual(['mail', 'mail', '{x.y}', 'mail']);
  });

  it('reads the name of an @InjectQueue or @Processor options object and of registerQueueAsync', () => {
    const { sites, unresolved } = findQueueNames([
      file(
        'libs/a/use.ts',
        [
          `@Processor({ name: '{a.b}', concurrency: 2 })\nclass P {}`,
          `BullModule.registerQueueAsync({ name: '{c.d}', useFactory: () => ({}) });`,
        ].join('\n'),
      ),
    ]);

    expect(unresolved).toEqual([]);
    expect(sites.map(({ name }) => name)).toEqual(['{a.b}', '{c.d}']);
  });

  it('ignores a decorator example inside a comment', () => {
    const { sites, unresolved } = findQueueNames([
      file('libs/a/host.ts', `/**\n * @example\n *   @Processor(QUEUE_NAMES.X)\n */\nexport class Host {}`),
    ]);

    expect(sites).toEqual([]);
    expect(unresolved).toEqual([]);
  });

  it('reports a computed name as unresolved rather than skipping it', () => {
    const { sites, unresolved } = findQueueNames([
      file('libs/a/m.ts', `BullModule.registerQueue({ name: prefix + 'x' });`),
    ]);

    expect(sites).toEqual([]);
    expect(unresolved).toEqual([{ file: 'libs/a/m.ts', line: 1, expression: `prefix + 'x'` }]);
  });

  it('reports a name with no declaration as unresolved', () => {
    const { unresolved } = findQueueNames([file('libs/a/m.ts', `@Processor(MISSING)\nclass P {}`)]);

    expect(unresolved).toEqual([expect.objectContaining({ expression: 'MISSING' })]);
  });

  it('reports a name defined twice with different values as unresolved', () => {
    const { sites, unresolved } = findQueueNames([
      file('libs/a/one.ts', `export const N = 'a';`),
      file('libs/b/two.ts', `export const N = 'b';`),
      file('libs/c/use.ts', `@Processor(N)\nclass P {}`),
    ]);

    expect(sites).toEqual([]);
    expect(unresolved).toEqual([expect.objectContaining({ file: 'libs/c/use.ts', expression: 'N' })]);
  });

  it('accepts a name defined twice with the same value', () => {
    const { sites, unresolved } = findQueueNames([
      file('libs/a/one.ts', `export const N = '{a.b}';`),
      file('libs/b/two.ts', `export const N = '{a.b}';`),
      file('libs/c/use.ts', `@Processor(N)\nclass P {}`),
    ]);

    expect(unresolved).toEqual([]);
    expect(sites).toEqual([expect.objectContaining({ name: '{a.b}' })]);
  });

  it('reports a name that is also declared with a computed value as unresolved', () => {
    const { unresolved } = findQueueNames([
      file('libs/a/one.ts', `export const N = '{a.b}';`),
      file('libs/b/two.ts', `export const N = build();`),
      file('libs/c/use.ts', `@Processor(N)\nclass P {}`),
    ]);

    expect(unresolved).toHaveLength(1);
  });

  it('reads an enum whose members have no initializer, which are numeric, without failing', () => {
    const { sites, unresolved } = findQueueNames([
      file('libs/a/direction.ts', `export enum Direction { Up, Down }`),
      file('libs/a/use.ts', `@Processor(Direction.Up)\nclass P {}`),
    ]);

    expect(sites).toEqual([]);
    expect(unresolved).toEqual([expect.objectContaining({ expression: 'Direction.Up' })]);
  });

  it.each([
    ['an aliased import', `import { Queue as BullQueue } from 'bullmq';\nnew BullQueue('plain');`],
    ['a namespace import', `import * as bullmq from 'bullmq';\nnew bullmq.Queue('plain');`],
    ['an aliased decorator', `import { Processor as Consumes } from '@nestjs/bullmq';\n@Consumes('plain')\nclass P {}`],
  ])("counts BullMQ's constructor or decorator through %s", (_label, text) => {
    const { sites } = findQueueNames([file('libs/a/use.ts', text)]);

    expect(sites).toEqual([expect.objectContaining({ name: 'plain', line: 2 })]);
  });

  it('leaves a Worker imported from node:worker_threads alone', () => {
    const { sites, unresolved } = findQueueNames([
      file(
        'libs/a/thread.ts',
        `import { Worker } from 'node:worker_threads';\nnew Worker(new URL('./w.js', import.meta.url));`,
      ),
    ]);

    expect(sites).toEqual([]);
    expect(unresolved).toEqual([]);
  });

  it("reports a re-export of BullMQ's constructors, whose importers the check can't follow", () => {
    const { reExports } = findQueueNames([
      file('libs/a/index.ts', `export { Queue, Job } from 'bullmq';\nexport * from '@nestjs/bullmq';`),
    ]);

    expect(reExports).toEqual([
      { file: 'libs/a/index.ts', line: 1, name: 'Queue' },
      { file: 'libs/a/index.ts', line: 2, name: '*' },
    ]);
  });

  it("reports an export of a binding imported from BullMQ, whose importers the check can't follow", () => {
    const { reExports } = findQueueNames([
      file(
        'libs/a/index.ts',
        [
          `import { Queue as BullQueue, Job } from 'bullmq';`,
          `import * as bull from '@nestjs/bullmq';`,
          `import { Worker } from 'node:worker_threads';`,
          `export { BullQueue, Job, Worker };`,
          `export { bull };`,
          `export type { BullQueue as QueueType };`,
          `export default BullQueue;`,
        ].join('\n'),
      ),
    ]);

    expect(reExports).toEqual([
      { file: 'libs/a/index.ts', line: 4, name: 'Queue' },
      { file: 'libs/a/index.ts', line: 5, name: '*' },
      { file: 'libs/a/index.ts', line: 7, name: 'Queue' },
    ]);
  });

  describe('a property a later spread could replace (#462)', () => {
    it('reports a name followed by a spread as unresolved', () => {
      const { sites, unresolved } = findQueueNames([
        file('libs/a/use.ts', `BullModule.registerQueue({ name: '{bge.safe}', ...options });`),
      ]);

      expect(sites).toEqual([]);
      expect(unresolved).toHaveLength(1);
    });

    it('resolves a name written after the spread, which it overrides', () => {
      const { sites, unresolved } = findQueueNames([
        file('libs/a/use.ts', `BullModule.registerQueue({ ...options, name: '{bge.safe}' });`),
      ]);

      expect(unresolved).toEqual([]);
      expect(sites).toEqual([expect.objectContaining({ name: '{bge.safe}' })]);
    });

    it("reports a flow job's queueName followed by a spread as unresolved", () => {
      const { sites, unresolved } = findQueueNames([
        file('libs/a/flow.ts', `const f = { queueName: '{bge.a}.p', ...job, children: [{ queueName: '{bge.a}.c' }] };`),
      ]);

      expect(sites).toEqual([expect.objectContaining({ name: '{bge.a}.c' })]);
      expect(unresolved).toEqual([expect.objectContaining({ expression: "queueName: '{bge.a}.p'" })]);
    });

    it("reports a flow's children followed by a spread as a flow it cannot follow", () => {
      const { unfollowedFlows } = findQueueNames([
        file('libs/a/flow.ts', `const f = { queueName: '{bge.a}.p', children: [{ queueName: '{bge.a}.c' }], ...job };`),
      ]);

      expect(unfollowedFlows).toHaveLength(1);
    });
  });

  describe("a flow's queues (#462)", () => {
    const names = file(
      'libs/a/q.ts',
      `export enum Q { Import = '{bge.games}.import', Fetch = '{bge.games}.fetch', Other = '{bge.other}' }`,
    );

    it("accepts children that share their parent's hash tag", () => {
      const { splitFlows, unfollowedFlows } = findQueueNames([
        names,
        file('libs/a/flow.ts', `const f = { queueName: Q.Import, children: [{ queueName: Q.Fetch }] };`),
      ]);

      expect(splitFlows).toEqual([]);
      expect(unfollowedFlows).toEqual([]);
    });

    it("reports a child whose hash tag differs from its parent's", () => {
      const { splitFlows } = findQueueNames([
        names,
        file(
          'libs/a/flow.ts',
          `const f = {\n  queueName: Q.Import,\n  children: [{ queueName: Q.Fetch }, { queueName: Q.Other }],\n};`,
        ),
      ]);

      expect(splitFlows).toEqual([
        { file: 'libs/a/flow.ts', line: 3, parent: '{bge.games}.import', child: '{bge.other}' },
      ]);
    });

    it('checks a grandchild against its own parent', () => {
      const { splitFlows } = findQueueNames([
        names,
        file(
          'libs/a/flow.ts',
          `const f = { queueName: Q.Import, children: [{ queueName: Q.Fetch, children: [{ queueName: Q.Other }] }] };`,
        ),
      ]);

      expect(splitFlows).toEqual([expect.objectContaining({ parent: '{bge.games}.fetch', child: '{bge.other}' })]);
    });

    it.each([
      ['children built elsewhere', `const f = { queueName: Q.Import, children: makeChildren() };`, 'makeChildren()'],
      ['a child built elsewhere', `const f = { queueName: Q.Import, children: [makeChild()] };`, 'makeChild()'],
      ['a spread child', `const f = { queueName: Q.Import, children: [...more] };`, '...more'],
    ])('reports %s as a flow it cannot follow', (_label, text, expression) => {
      const { unfollowedFlows } = findQueueNames([names, file('libs/a/flow.ts', text)]);

      expect(unfollowedFlows).toEqual([expect.objectContaining({ expression })]);
    });
  });

  it('reports @Processor() with no argument as unresolved', () => {
    const { unresolved } = findQueueNames([file('libs/a/use.ts', `@Processor()\nclass P {}`)]);

    expect(unresolved).toHaveLength(1);
  });

  // A name another definition could stand for must never resolve to a braced
  // literal that hides an unbraced queue (#462).
  describe('a name that another definition could stand for (#462)', () => {
    const braced = file('libs/b/braced.ts', `export const Q = { mail: '{bge.mail}' };`);
    const use = file('libs/c/use.ts', `@Processor(Q.mail)\nclass P {}`);

    it.each([
      ['an object member that is a template', `export const Q = { mail: \`\${P}.mail\` };`],
      ['a shorthand object member', `const mail = 'plain';\nexport const Q = { mail };`],
      ['an object with a spread', `export const Q = { ...others };`],
      ['an object with a computed key', `export const Q = { [key]: 'plain' };`],
      ['an owner that is not an object', `export const Q = buildQueues();`],
      ['a string enum member that is a template', 'export enum Q { mail = `${P}.mail` }'],
      ['an enum with a computed member', `export enum Q { ['mail'] = 'plain', [key] = 'x' }`],
      // `const` stops a rebinding, not a member write.
      ['a write to the member', `Q.mail = 'plain';`],
      ['a write to the member by element', `Q['mail'] = 'plain';`],
      ['a compound write to the member', `Q.mail += '.plain';`],
    ])('reports %s as unresolved', (_label, text) => {
      const { sites, unresolved } = findQueueNames([file('libs/a/other.ts', text), braced, use]);

      expect(sites).toEqual([]);
      expect(unresolved).toEqual([expect.objectContaining({ file: 'libs/c/use.ts', expression: 'Q.mail' })]);
    });

    it.each([
      ['an aliased import', `import { PLAIN as QUEUE } from './c';`],
      ['an aliased export', `const PLAIN = 'plain';\nexport { PLAIN as QUEUE };`],
      ['a default import', `import QUEUE from './c';`],
      ['a namespace import', `import * as QUEUE from './c';`],
      ['a parameter', `function make(QUEUE: string) { return 1; }`],
      ['a let', `let QUEUE = 'plain';`],
      ['a destructured name', `const { QUEUE } = settings;`],
    ])('reports a name shadowed by %s as unresolved', (_label, text) => {
      const { sites, unresolved } = findQueueNames([
        file('libs/a/other.ts', text),
        file('libs/b/braced.ts', `export const QUEUE = '{bge.b.q}';`),
        file('libs/c/use.ts', `new Queue(QUEUE);`),
      ]);

      expect(sites).toEqual([]);
      expect(unresolved).toEqual([expect.objectContaining({ file: 'libs/c/use.ts', expression: 'QUEUE' })]);
    });

    it('still resolves a plain, unaliased import of the constant', () => {
      const { sites, unresolved } = findQueueNames([
        file('libs/a/other.ts', `import { QUEUE } from './braced';`),
        file('libs/b/braced.ts', `export const QUEUE = '{bge.b.q}';`),
        file('libs/c/use.ts', `new Queue(QUEUE);`),
      ]);

      expect(unresolved).toEqual([]);
      expect(sites).toEqual([expect.objectContaining({ name: '{bge.b.q}' })]);
    });
  });
});

describe('checkQueueHashTags (#462)', () => {
  describe('on the repository tree (#462)', () => {
    it('reports no problems, so every queue name on the tree carries a hash tag (#462)', () => {
      const { problems } = checkQueueHashTags(REPO_ROOT);

      expect(problems).toEqual([]);
    });

    it('finds the braced queues, so the check cannot pass over nothing', () => {
      const { sites } = checkQueueHashTags(REPO_ROOT);
      const names = new Set(sites.map(({ name }) => name));

      for (const name of [
        '{bge.games}.import',
        '{bge.games}.fetch',
        '{bge.media.contribution-sweep}',
        '{bge.friendship.extended-network}',
        '{bge.gateway.vocabulary}',
        '{bge.mail.delivery}',
        '{bge.webhooks.delivery}',
        '{bge.feedback.delivery}',
      ]) {
        expect(names).toContain(name);
      }
    });

    it('leaves the JSDoc examples in the worker hosts alone', () => {
      const { sites } = checkQueueHashTags(REPO_ROOT);

      expect(sites.filter(({ file }) => /\.worker-host\.ts$/.test(file))).toEqual([]);
    });
  });

  describe('on a scratch repository (#462)', () => {
    let root;

    function git(args, cwd = root) {
      return execFileSync('git', args, { cwd, env: ENV_WITHOUT_GIT, encoding: 'utf8', stdio: 'pipe' });
    }

    function track(relativePath, contents) {
      const target = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
      git(['add', '--', relativePath]);
    }

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'bge-queue-hash-tags-'));
      git(['init', '--quiet']);
    });

    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('fails when it finds no queue-name sites at all', () => {
      expect(checkQueueHashTags(root)).toEqual({
        sites: [],
        problems: [expect.stringContaining('no queue-name sites found')],
      });
    });

    it('passes when every site is braced', () => {
      track('libs/a/m.ts', `BullModule.registerQueue({ name: '{bge.a.b}' });`);

      expect(checkQueueHashTags(root)).toEqual({
        sites: [{ file: 'libs/a/m.ts', line: 1, name: '{bge.a.b}' }],
        problems: [],
      });
    });

    it('reports one problem per unbraced name, listing every use site', () => {
      track('libs/a/c.ts', `export const N = 'plain';`);
      track('libs/a/m.ts', `BullModule.registerQueue({ name: N });\n@Processor(N)\nclass P {}`);

      const { problems } = checkQueueHashTags(root);

      expect(problems).toEqual([
        expect.stringMatching(/"plain".*libs\/a\/c\.ts:1.*libs\/a\/m\.ts:1, libs\/a\/m\.ts:2/),
      ]);
    });

    it('skips specs, typings and e2e apps, and checks an untracked file', () => {
      track('libs/a/m.ts', `BullModule.registerQueue({ name: '{bge.a.b}' });`);
      track('libs/a/m.spec.ts', `new Queue('plain');`);
      track('libs/a/m.e2e-spec.ts', `new Queue('plain');`);
      track('libs/a/m.d.ts', `new Queue('plain');`);
      track('apps/api-e2e/src/q.ts', `new Queue('plain');`);
      fs.writeFileSync(path.join(root, 'libs/a/fresh.ts'), `new Queue('fresh');`);

      expect(checkQueueHashTags(root).problems).toEqual([expect.stringContaining('"fresh"')]);
    });

    it('checks .mts, .cts and .tsx source, and skips their specs and typings', () => {
      track('libs/a/m.mts', `new Queue('in-mts');`);
      track('libs/a/m.cts', `new Queue('in-cts');`);
      track('libs/a/m.tsx', `new Queue('in-tsx');`);
      track('libs/a/m.spec.mts', `new Queue('plain');`);
      track('libs/a/m.d.mts', `new Queue('plain');`);

      expect(checkQueueHashTags(root).problems).toEqual([
        expect.stringContaining('"in-cts"'),
        expect.stringContaining('"in-mts"'),
        expect.stringContaining('"in-tsx"'),
      ]);
    });

    it('fails a flow whose child carries another hash tag', () => {
      track('libs/a/flow.ts', `const f = { queueName: '{bge.a}.parent', children: [{ queueName: '{bge.b}.child' }] };`);

      expect(checkQueueHashTags(root).problems).toEqual([
        expect.stringMatching(/libs\/a\/flow\.ts:1: flow child queue "\{bge\.b\}\.child".*"\{bge\.a\}\.parent"/),
      ]);
    });

    it('skips a tracked file deleted from the working tree', () => {
      track('libs/a/m.ts', `BullModule.registerQueue({ name: '{bge.a.b}' });`);
      track('libs/a/gone.ts', `new Queue('plain');`);
      fs.rmSync(path.join(root, 'libs/a/gone.ts'));

      expect(checkQueueHashTags(root).problems).toEqual([]);
    });

    it('refuses a root below the top of its repository', () => {
      track('libs/a/m.ts', `new Queue('plain');`);
      const libs = path.join(root, 'libs');

      expect(() => checkQueueHashTags(libs)).toThrow(`${libs} is not the top of its git repository`);
    });
  });
});
