import { getFreePort, requireBundle, WORKSPACE_ROOT } from '@bge/testing-e2e/child-process';
import { pollUntil } from '@bge/testing-e2e/poll';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { parseLogRecords, type LogRecord } from './logs';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = path.join(WORKSPACE_ROOT, 'apps', 'image-smoke');

/**
 * Where runs leave what they wrote, in a directory named after each run's
 * Compose project: the stack's settings and every container's output.
 */
export const OUTPUT_DIR = path.join(PROJECT_ROOT, 'test-output');

/** The run's settings, which Compose reads in place of a `.env`. */
const envFileIn = (runDir: string) => path.join(runDir, 'stack.env');

/**
 * BGE_SMOKE_KEEP=true leaves the stack running at the end, for a look at what
 * failed. The suite then skips its shutdown, which would stop the stack.
 */
export const KEEP_STACK = process.env['BGE_SMOKE_KEEP'] === 'true';

/** The four roles, each in a container of its own, as the split profile runs them. */
export const ROLES = ['api', 'worker', 'gateway-fetch', 'coordinator'] as const;

/** The game gateways: the stub the suite searches through, and both published gateway images. */
export const GATEWAYS = ['stub-gateway', 'boardgamegeek-gateway', 'igdb-gateway'] as const;

/**
 * Started by name: `up` on the whole split profile would start a service the
 * suite doesn't configure, so a service only starts here once it is listed.
 * The gateways in the profile are the reason (#637).
 */
export const SMOKE_SERVICES = ['postgres', 'redis', ...ROLES, ...GATEWAYS, 'igdb-token'] as const;

export type SmokeService = (typeof SMOKE_SERVICES)[number];

/**
 * The roles that listen on nothing, so nothing probes them: their
 * `Bootstrap complete` line is the evidence they came up (docs/DEPLOYMENT.md).
 */
const LOG_READY_ROLES = ['worker', 'gateway-fetch'] as const;

/**
 * Covers a cold first boot on a slow runner: the api migrates and seeds an
 * empty database before anything listens, and the other roles wait for it.
 */
const UP_TIMEOUT_S = 600;
const BOOTSTRAP_LINE_TIMEOUT_MS = 120_000;

/** The images under test. */
export interface CandidateImages {
  readonly bge: string;
  readonly boardgamegeekGateway: string;
  readonly igdbGateway: string;

  /**
   * Built here, from `bge` and the stub's bundle. Named after the project, as
   * Compose names an image it builds, so a run beside another builds its own.
   */
  readonly stubGateway: string;
}

/** What a container's state says about it, from `docker inspect`. */
export interface ContainerState {
  readonly service: string;
  readonly status: string;
  readonly exitCode: number;
  readonly oomKilled: boolean;
  readonly restartCount: number;
  /** Undefined for a service without a healthcheck. */
  readonly health: string | undefined;
}

interface InspectedContainer {
  readonly RestartCount: number;
  readonly State: {
    readonly Status: string;
    readonly ExitCode: number;
    readonly OOMKilled: boolean;
    readonly Health?: { readonly Status: string };
  };
  readonly Config: { readonly Labels: Record<string, string> };
}

async function docker(args: readonly string[], options: { env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync('docker', [...args], {
      cwd: WORKSPACE_ROOT,
      env: options.env ?? process.env,
      maxBuffer: 256 * 1024 * 1024,
    });

    return stdout;
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    throw new Error(`docker ${args.join(' ')} failed:\n${[stderr, stdout].filter(Boolean).join('\n')}`, {
      cause: error,
    });
  }
}

/** `docker compose` for a run: compose.yaml and the suite's override, as the split profile, with the run's env file. */
function composeArgs(project: string, runDir: string, args: readonly string[]): string[] {
  return [
    'compose',
    '--project-name',
    project,
    '--project-directory',
    WORKSPACE_ROOT,
    '--env-file',
    envFileIn(runDir),
    '--file',
    path.join(WORKSPACE_ROOT, 'compose.yaml'),
    '--file',
    path.join(PROJECT_ROOT, 'compose.smoke.yaml'),
    '--profile',
    'split',
    ...args,
  ];
}

/**
 * This process's environment without the variables the compose files read,
 * for Compose to run in. Compose takes a variable from the environment it
 * runs in before its env file, and Nx loads the checkout's `.env` into every
 * task. That file's development settings (its secrets, its log level, any
 * port or URL) would otherwise replace the run's. Compose lists the variables
 * itself, so one added to compose.yaml is covered.
 */
async function composeEnvironment(project: string, runDir: string): Promise<NodeJS.ProcessEnv> {
  const variables = JSON.parse(
    await docker(composeArgs(project, runDir, ['config', '--variables', '--format', 'json'])),
  ) as Record<string, unknown>;

  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !(name in variables)));
}

/**
 * The images the variables compose.yaml reads name, or else compose.yaml's
 * own defaults, as Compose reports them: the names `docker compose --profile
 * split build` tags. Read from Compose, so a run can't test a stale image
 * under a name compose.yaml no longer builds.
 */
async function candidateImages(project: string): Promise<CandidateImages> {
  const variables = JSON.parse(
    await docker([
      'compose',
      '--file',
      path.join(WORKSPACE_ROOT, 'compose.yaml'),
      '--profile',
      'split',
      'config',
      '--variables',
      '--format',
      'json',
    ]),
  ) as Partial<Record<string, { readonly DefaultValue: string }>>;

  const image = (name: string): string => {
    const named = process.env[name] || variables[name]?.DefaultValue;
    if (!named) {
      throw new Error(`${name} is unset, and compose.yaml gives it no default`);
    }

    return named;
  };

  return {
    bge: image('BGE_IMAGE'),
    boardgamegeekGateway: image('BGE_BOARDGAMEGEEK_GATEWAY_IMAGE'),
    igdbGateway: image('BGE_IGDB_GATEWAY_IMAGE'),
    stubGateway: `${project}-stub-gateway`,
  };
}

/** Fails naming the image to build when one is missing, rather than letting Compose try to pull it. */
async function requireImages(images: readonly string[]): Promise<void> {
  for (const image of images) {
    try {
      await docker(['image', 'inspect', '--format', '{{.Id}}', image]);
    } catch (error) {
      // Only a missing image calls for a build. Any other failure, such as a
      // Docker daemon that isn't running, is reported as Docker gave it.
      if (!/No such image/.test((error as Error).message)) {
        throw error;
      }

      throw new Error(
        `The image ${image} is not on this machine. Build the images to test first, from the repository root:\n` +
          '  docker compose --profile split build\n' +
          'or name built images in BGE_IMAGE, BGE_BOARDGAMEGEEK_GATEWAY_IMAGE and BGE_IGDB_GATEWAY_IMAGE.',
        { cause: error },
      );
    }
  }
}

/** The stub gateway's image: the candidate BGE image with the stub's bundle added (apps/stub-gateway/Dockerfile). */
async function buildStubImage(images: CandidateImages): Promise<void> {
  const dist = path.join(WORKSPACE_ROOT, 'apps', 'stub-gateway', 'dist');
  const buildTarget = '@boardgamesempire/stub-gateway:build';
  requireBundle('Stub gateway', path.join(dist, 'main.js'), buildTarget);
  // The protos it serves from: a bundle built without them boots a stub that
  // exits at once.
  requireBundle('Stub gateway proto', path.join(dist, 'proto'), buildTarget);

  await docker([
    'build',
    '--file',
    path.join(WORKSPACE_ROOT, 'apps', 'stub-gateway', 'Dockerfile'),
    '--build-arg',
    `BGE_IMAGE=${images.bge}`,
    '--tag',
    images.stubGateway,
    WORKSPACE_ROOT,
  ]);
}

/**
 * The split profile, started from compose.yaml and the suite's override under
 * a project of its own, on an empty database, with secrets generated for the
 * run.
 */
export class Stack {
  private constructor(
    readonly project: string,
    readonly baseUrl: string,
    /** Where this run leaves its settings and its containers' output. */
    private readonly runDir: string,
    /** What Compose runs in: {@link composeEnvironment}. */
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  /**
   * The longest {@link start} runs before a timeout of its own fires: `up`'s
   * wait, the bootstrap lines after it, and room for the stub's build, image
   * pulls and the report on a failed boot. A hook that allows this sees a
   * stalled boot fail here, with every container's output saved and the stack
   * removed. A shorter one gives up first, and both are lost.
   */
  static readonly START_TIMEOUT_MS = UP_TIMEOUT_S * 1000 + BOOTSTRAP_LINE_TIMEOUT_MS + 5 * 60_000;

  static async start(): Promise<Stack> {
    // BGE_SMOKE_PROJECT names another project, to run beside a stack of this
    // name, such as another worktree's run. The project names everything a
    // run leaves: its containers and volumes, the stub's image and its files.
    const project = process.env['BGE_SMOKE_PROJECT'] || 'bge-image-smoke';
    const runDir = path.join(OUTPUT_DIR, project);

    const images = await candidateImages(project);
    await requireImages([images.bge, images.boardgamegeekGateway, images.igdbGateway]);
    await buildStubImage(images);

    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;

    // The only source of the variables the compose files read: Compose runs
    // without them otherwise, and reads this file in place of a `.env`.
    const settings = {
      BGE_IMAGE: images.bge,
      BGE_BOARDGAMEGEEK_GATEWAY_IMAGE: images.boardgamegeekGateway,
      BGE_IGDB_GATEWAY_IMAGE: images.igdbGateway,
      BGE_STUB_GATEWAY_IMAGE: images.stubGateway,
      BGE_PORT: String(port),
      BGE_PUBLIC_URL: baseUrl,
      BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
      DATA_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      LOG_LEVEL: 'info',
    };

    // What an earlier run under this project left, its logs among them, would
    // read as this run's.
    await fs.rm(runDir, { recursive: true, force: true });
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      envFileIn(runDir),
      Object.entries(settings)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );

    const stack = new Stack(project, baseUrl, runDir, await composeEnvironment(project, runDir));

    // A stack left by an earlier run would boot on its database, and the
    // first boot is part of what this tests.
    await stack.compose(['down', '--volumes', '--remove-orphans']);

    try {
      await stack.compose([
        'up',
        '--detach',
        '--no-build',
        '--wait',
        '--wait-timeout',
        String(UP_TIMEOUT_S),
        ...SMOKE_SERVICES,
      ]);

      // One budget for both roles' lines, from the moment `up` returns.
      const deadline = Date.now() + BOOTSTRAP_LINE_TIMEOUT_MS;
      for (const role of LOG_READY_ROLES) {
        await stack.waitForLog(role, 'Bootstrap complete', Math.max(0, deadline - Date.now()));
      }
    } catch (error) {
      // The suite never receives a stack that failed to start, so this one
      // saves its output and removes itself before failing. Failing to remove
      // it is reported beside the reason it didn't start, not in its place.
      const description = await stack.describe();
      const removal = await stack.teardown().then(
        () => '',
        (teardownError: Error) => `\nRemoving the stack failed too: ${teardownError.message}`,
      );
      throw new Error(`The stack did not come up: ${(error as Error).message}\n${description}${removal}`, {
        cause: error,
      });
    }

    return stack;
  }

  /** `docker compose` for this stack. */
  compose(args: readonly string[]): Promise<string> {
    return docker(composeArgs(this.project, this.runDir, args), { env: this.env });
  }

  /** Everything a service's container has written, colour codes included. */
  logs(service: SmokeService): Promise<string> {
    return this.compose(['logs', '--no-color', '--no-log-prefix', service]);
  }

  async records(service: SmokeService): Promise<LogRecord[]> {
    return parseLogRecords(await this.logs(service));
  }

  waitForLog(service: SmokeService, text: string, timeoutMs: number): Promise<LogRecord> {
    return pollUntil(async () => (await this.records(service)).find((record) => record.text.includes(text)), {
      description: `${service} to log '${text}'`,
      timeoutMs,
      intervalMs: 1_000,
    });
  }

  private async inspect(service: SmokeService): Promise<InspectedContainer> {
    const id = (await this.compose(['ps', '--all', '--quiet', service])).trim();
    if (!id) {
      throw new Error(`${service} has no container`);
    }

    const [container] = JSON.parse(await docker(['inspect', id])) as InspectedContainer[];
    return container;
  }

  async state(service: SmokeService): Promise<ContainerState> {
    const { RestartCount, State } = await this.inspect(service);

    return {
      service,
      status: State.Status,
      exitCode: State.ExitCode,
      oomKilled: State.OOMKilled,
      restartCount: RestartCount,
      health: State.Health?.Status,
    };
  }

  /** A label of the image the service's container runs. */
  async imageLabel(service: SmokeService, label: string): Promise<string | undefined> {
    return (await this.inspect(service)).Config.Labels[label];
  }

  /** What `ps` shows and each service's last lines: what a failure needs beside it. */
  async describe(): Promise<string> {
    const failed = (error: Error) => error.message;
    const parts = await Promise.all([
      this.compose(['ps', '--all']).catch(failed),
      ...SMOKE_SERVICES.map(async (service) => {
        const tail = await this.compose(['logs', '--no-color', '--tail', '30', service]).catch(failed);
        return `--- ${service} (last 30 lines) ---\n${tail}`;
      }),
    ]);

    return parts.join('\n');
  }

  /**
   * Saves each service's output beside the run's settings, then removes the
   * stack and its volumes, unless {@link KEEP_STACK} leaves it in place.
   */
  async teardown(): Promise<void> {
    const logDir = path.join(this.runDir, 'logs');
    await fs.mkdir(logDir, { recursive: true });

    await Promise.all(
      SMOKE_SERVICES.map(async (service) => {
        const output = await this.logs(service).catch((error: Error) => error.message);
        await fs.writeFile(path.join(logDir, `${service}.log`), output);
      }),
    );

    const removal = ['down', '--volumes', '--remove-orphans'];
    if (KEEP_STACK) {
      // Absolute paths, so the command runs from any directory.
      const command = ['docker', ...composeArgs(this.project, this.runDir, removal)]
        .map((arg) => (/\s/.test(arg) ? `'${arg}'` : arg))
        .join(' ');
      console.log(`[smoke] left ${this.project} in place, at ${this.baseUrl}. Remove it with:\n  ${command}`);
      return;
    }

    await this.compose(removal);
  }
}
