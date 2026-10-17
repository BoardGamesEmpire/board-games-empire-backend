import { environments, type Environment } from '@bge/env';
import { beforeAll, describe, expect, it } from '@jest/globals';
import type { DynamicModule, FactoryProvider, ForwardReference, Type } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import { ConfigModule, type ConfigFactory, type ConfigModuleOptions } from '@nestjs/config';
import { parse } from 'dotenv';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { missingFrom, withEnvironmentAsync } from './missing-variables.helper.js';
import { WORKSPACE_ROOT } from './workspace-root.js';

/** The template a developer copies to `.env`. */
const TEMPLATE = path.join(WORKSPACE_ROOT, '.env.example');

/**
 * What the root module is imported under. Its `ConfigModule.forRoot` runs on
 * import, so this must satisfy it. Telemetry stays off, and the logs quiet.
 */
const IMPORT_ENVIRONMENT = { NODE_ENV: 'development', OTEL_SDK_DISABLED: 'true', LOG_LEVEL: 'silent' };

export interface RequiredConfiguration {
  /** The options the process role's root module passes to `ConfigModule.forRoot`. */
  readonly options: ConfigModuleOptions;

  /** Imports the root module, whose imports are searched for every config the process role loads. */
  readonly rootModule: () => Promise<Type>;

  /** The variables an operator must set, by environment. An environment left out requires none. */
  readonly required: Partial<Record<Environment, readonly string[]>>;

  /** Two or more variables set to values validation rejects. */
  readonly malformed: Record<string, string>;
}

interface LoadResult {
  /** Nest's message when validation fails. */
  readonly invalid?: string;

  /** The variables the process role's configs report missing, sorted. */
  readonly missing: readonly string[];
}

/**
 * Checks, for each environment `NODE_ENV` may name, that a process role starts
 * with exactly the variables an operator must set, and with nothing more.
 * Both layers run as they do at boot: Nest's `ConfigModule` validates first and
 * writes the schema's defaults into the environment, then every config the
 * process role loads, at its root or with `forFeature`, reads it. Run with
 * nothing set, with `.env.example` read the way the process role reads `.env`,
 * and with the template's commented-out, valueless lines uncommented. The
 * database's variables are outside it: the bootstrap's own `ConfigModule`
 * validates them.
 */
export function describeRequiredConfiguration(processRole: string, configuration: RequiredConfiguration): void {
  const { options, rootModule, required, malformed } = configuration;
  const template = readFileSync(TEMPLATE, 'utf8');
  const templateVariables = Object.keys(parse(template));

  /** What the template's commented-out, valueless lines set once a developer uncomments them unfilled. */
  const uncommented = Object.fromEntries(
    [...template.matchAll(/^#([A-Z][A-Z0-9_]*)=$/gm)].map(([, variable]) => [variable, '']),
  );

  describe(`the ${processRole}'s configuration`, () => {
    let factories: readonly ConfigFactory[] = [];

    beforeAll(async () => {
      factories = await withEnvironmentAsync(IMPORT_ENVIRONMENT, async () => configFactories(await rootModule()));
    });

    it('finds the configs the process role loads', () => {
      expect(factories.length).toBeGreaterThan(0);
    });

    it('names every malformed variable at once, not only the first', async () => {
      const { invalid } = await loadConfiguration(options, factories, { ...malformed, NODE_ENV: 'development' });

      for (const variable of Object.keys(malformed)) {
        expect(invalid).toContain(`"${variable}"`);
      }
    });

    // A name outside them matches no per-environment default, so every one
    // would silently miss (#290).
    it('refuses a NODE_ENV outside the environments', async () => {
      const { invalid } = await loadConfiguration(options, factories, { NODE_ENV: 'testing' });

      expect(invalid).toContain('"NODE_ENV"');
    });

    describe.each(environments)('under NODE_ENV=%s', (environment) => {
      const expected = [...(required[environment] ?? [])].sort();
      const fromTemplate = expected.filter((variable) => !templateVariables.includes(variable));

      it('with nothing set, misses exactly the variables an operator must set', async () => {
        expect(await loadConfiguration(options, factories, { NODE_ENV: environment })).toEqual({ missing: expected });
      });

      it('from .env.example, misses exactly those it leaves out', async () => {
        expect(await loadConfiguration(options, factories, { NODE_ENV: environment }, TEMPLATE)).toEqual({
          missing: fromTemplate,
        });
      });

      // `@bge/env` reads an empty variable as unset, so validation must too.
      it('from .env.example with its empty lines uncommented, misses the same', async () => {
        expect(Object.keys(uncommented)).not.toEqual([]);
        expect(
          await loadConfiguration(options, factories, { ...uncommented, NODE_ENV: environment }, TEMPLATE),
        ).toEqual({ missing: fromTemplate });
      });
    });
  });
}

/**
 * Validates `variables` and an env file through Nest's real `ConfigModule`,
 * then calls every config factory against what that leaves in the environment.
 */
function loadConfiguration(
  options: ConfigModuleOptions,
  factories: readonly ConfigFactory[],
  variables: Record<string, string>,
  envFile?: string,
): Promise<LoadResult> {
  return withEnvironmentAsync(variables, async () => {
    try {
      await ConfigModule.forRoot({ ...options, envFilePath: envFile, ignoreEnvFile: envFile === undefined });
    } catch (error) {
      return { invalid: (error as Error).message, missing: [] };
    }

    const missing = factories.flatMap((factory) => missingFrom(factory));

    return { missing: [...new Set(missing)].sort() };
  });
}

type ModuleEntry = Type | DynamicModule | ForwardReference | Promise<DynamicModule>;

/** Every config a module loads through `ConfigModule`, itself or through any module it imports. */
async function configFactories(root: Type): Promise<ConfigFactory[]> {
  const factories = new Set<ConfigFactory>();
  const visited = new Set<unknown>();

  const visit = async (entry: ModuleEntry): Promise<void> => {
    const resolved = await entry;
    const module = 'forwardRef' in resolved ? resolved.forwardRef() : resolved;
    if (visited.has(module)) {
      return;
    }
    visited.add(module);

    const dynamic = 'module' in module ? module : undefined;
    if (dynamic?.module === ConfigModule) {
      for (const provider of dynamic.providers ?? []) {
        const factory = (provider as Partial<FactoryProvider>).useFactory as
          | (ConfigFactory & { KEY?: string })
          | undefined;
        if (factory?.KEY) {
          factories.add(factory);
        }
      }
    }

    const imports: ModuleEntry[] = [
      ...(Reflect.getMetadata(MODULE_METADATA.IMPORTS, dynamic?.module ?? module) ?? []),
      ...(dynamic?.imports ?? []),
    ];
    for (const child of imports) {
      await visit(child);
    }
  };

  await visit(root);
  return [...factories];
}
