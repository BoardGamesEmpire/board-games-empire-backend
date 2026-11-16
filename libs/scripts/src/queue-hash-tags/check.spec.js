'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkQueueHashTags, findQueueNames, hasHashTag } = require('./check');

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
  ])('%s -> %s', (name, expected) => {
    expect(hasHashTag(name)).toBe(expected);
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
      file('libs/a/q.ts', `export enum QueueNames {\n  GamesImport = '{bge.games.import}',\n}`),
    ]);

    expect(unresolved).toEqual([]);
    expect(sites).toEqual([expect.objectContaining({ name: '{bge.games.import}', line: 1 })]);
  });

  it('resolves a flow child queueName that is an enum member', () => {
    const { sites } = findQueueNames([
      file('libs/a/flow.ts', `const f = { queueName: QueueNames.GatewayFetch };`),
      file('libs/a/q.ts', `export enum QueueNames { GatewayFetch = '{bge.gateway.fetch}' }`),
    ]);

    expect(sites).toEqual([expect.objectContaining({ name: '{bge.gateway.fetch}' })]);
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
    // Rewritten when the three queues are renamed (#462).
    it('flags exactly the three unbraced queues, each naming its constants file', () => {
      const { problems } = checkQueueHashTags(REPO_ROOT);

      expect(problems).toHaveLength(3);
      for (const name of ['mail-delivery', 'webhook-delivery', 'feedback-delivery']) {
        expect(problems.filter((message) => message.includes(`"${name}"`))).toHaveLength(1);
      }
    });

    it('names the constants file that declares each unbraced queue', () => {
      const { problems } = checkQueueHashTags(REPO_ROOT);
      const declaredAt = {
        'mail-delivery': 'libs/queue/mail/src/lib/constants/mail-queue.constants.ts',
        'webhook-delivery': 'libs/queue/webhooks/src/lib/constants/webhook-queue.constants.ts',
        'feedback-delivery': 'libs/queue/feedback/src/lib/constants/feedback-queue.constants.ts',
      };

      for (const [name, constants] of Object.entries(declaredAt)) {
        const problem = problems.find((message) => message.includes(`"${name}"`));

        expect(problem).toContain(constants);
      }
    });

    it('finds the braced queues, so the check cannot pass over nothing', () => {
      const { sites } = checkQueueHashTags(REPO_ROOT);
      const names = new Set(sites.map(({ name }) => name));

      for (const name of [
        '{bge.games.import}',
        '{bge.gateway.fetch}',
        '{bge.media.contribution-sweep}',
        '{bge.friendship.extended-network}',
        '{bge.gateway.vocabulary}',
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
