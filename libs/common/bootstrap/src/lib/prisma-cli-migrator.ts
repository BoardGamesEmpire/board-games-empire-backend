import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { MigratorContext } from './bootstrap-options';
import type { Migrator } from './ports';

/**
 * Prisma 7 exposes no in-process migrate API, so the api's migrator is the
 * CLI as a child process (#236): `node <prisma/build/index.js>
 * migrate deploy`, resolved from the project that holds `prisma.config.ts`
 * so the container's own `prisma` install is what runs — never `npx`, which
 * would reach for the network in an offline image.
 */
export interface PrismaCliMigratorOptions extends MigratorContext {
  /** Where `prisma.config.ts` lives. Defaults to the working directory, then the bundle's directory. */
  readonly projectRoot?: string;
}

export class MigrateDeployFailedError extends Error {
  constructor(
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
  ) {
    super(
      `\`prisma migrate deploy\` ${signal ? `was killed by ${signal}` : `exited with status ${String(exitCode)}`}. ` +
        'Its output is logged above. The database is left as the failed migration left it; see `prisma migrate resolve`.',
    );
    this.name = 'MigrateDeployFailedError';
  }
}

/** The CLI or its project could not be found; thrown only when a migration actually needs it. */
export class MigratorUnavailableError extends Error {
  constructor(readonly reason: unknown) {
    super(`This build cannot apply migrations: ${reason instanceof Error ? reason.message : String(reason)}`);
    this.name = 'MigratorUnavailableError';
  }
}

/**
 * The first candidate directory holding `prisma.config.ts`. Pure so the search
 * order is a unit test: the working directory first (`nx serve`, the e2e
 * harness), then the bundle directory (`/app` in the container).
 */
export function findPrismaProjectRoot(
  candidates: readonly string[],
  exists: (candidate: string) => boolean = existsSync,
): string {
  const looked = candidates.filter((candidate) => candidate.length > 0);

  for (const candidate of looked) {
    if (exists(path.join(candidate, 'prisma.config.ts'))) {
      return candidate;
    }
  }

  throw new Error(
    `prisma.config.ts not found; the migrator needs the project that owns the migrations. Looked in: ${looked.join(', ')}. ` +
      'In a container this means the image was built without the prisma/ assets (see apps/api/webpack.config.js).',
  );
}

export function defaultProjectRootCandidates(): string[] {
  return [process.cwd(), path.dirname(process.argv[1] ?? '')];
}

interface ResolvedCli {
  readonly projectRoot: string;
  readonly cli: string;
}

function resolveCli(projectRoot: string | undefined): ResolvedCli {
  const root = projectRoot ?? findPrismaProjectRoot(defaultProjectRootCandidates());
  // `createRequire` keeps this a runtime resolution from the project's own
  // node_modules; a static `require.resolve` would be rewritten by the bundler.
  return { projectRoot: root, cli: createRequire(path.join(root, 'package.json')).resolve('prisma/build/index.js') };
}

export interface LineForwarder {
  write(chunk: Buffer): void;
  /** Emits whatever the last chunk left unterminated. */
  end(): void;
}

/**
 * Turns a child's stdout or stderr into whole lines. A chunk boundary can fall
 * anywhere, and Prisma's error text is only useful intact.
 */
export function createLineForwarder(emit: (line: string) => void): LineForwarder {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const flush = (text: string): void => {
    if (text.trim().length > 0) emit(text);
  };

  return {
    write(chunk) {
      pending += decoder.write(chunk);
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) flush(line);
    },
    end() {
      flush(pending + decoder.end());
      pending = '';
    },
  };
}

export function createPrismaCliMigrator(options: PrismaCliMigratorOptions): Migrator {
  // Resolved now, so an image missing its prisma assets says so in the log of
  // every boot; thrown only when a migration is pending, because an in-sync
  // database does not need the CLI and refusing to serve over a capability
  // nobody asked for would ground the api on a defect that only the next
  // migration would exercise.
  let resolved: ResolvedCli | MigratorUnavailableError;
  try {
    resolved = resolveCli(options.projectRoot);
  } catch (error) {
    resolved = new MigratorUnavailableError(error);
    options.logger.warn(
      `${resolved.message} This boot proceeds; a pending migration will refuse it until the image ships its prisma assets.`,
    );
  }

  return {
    apply: (pending) =>
      new Promise<void>((resolve, reject) => {
        if (resolved instanceof MigratorUnavailableError) {
          reject(resolved);
          return;
        }
        const { projectRoot, cli } = resolved;

        options.logger.log(`Running \`prisma migrate deploy\` in ${projectRoot} for ${pending.length} migration(s).`);

        const child = spawn(process.execPath, [cli, 'migrate', 'deploy'], {
          cwd: projectRoot,
          env: { ...process.env, DATABASE_URL: options.databaseUrl },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const stdout = createLineForwarder((line) => options.logger.log(`[prisma] ${line}`));
        const stderr = createLineForwarder((line) => options.logger.warn(`[prisma] ${line}`));
        child.stdout.on('data', (chunk: Buffer) => stdout.write(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderr.write(chunk));
        child.once('error', reject);
        // `close`, not `exit`: the pipes are drained only by then, and the
        // failure message sends the operator to the output above it.
        child.once('close', (code, signal) => {
          stdout.end();
          stderr.end();
          if (code === 0) resolve();
          else reject(new MigrateDeployFailedError(code, signal));
        });
      }),
  };
}
