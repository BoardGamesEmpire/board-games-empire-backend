import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Reads the physical names out of `prisma/models/*.prisma`, for specs that pin
 * hand-written SQL against the schema it addresses.
 *
 * Raw SQL names tables, columns and enum types directly, so a `@@map` or `@map`
 * rename compiles, passes every unit test that stubs the client, and fails only
 * at runtime. The guard is to read the mapped names back out of the model files
 * and require the statement to use those — which is why these helpers parse
 * text rather than importing anything: Prisma exposes no DMMF at runtime, and a
 * spec that hard-coded the names would be pinning a copy of the thing it is
 * supposed to be checking.
 *
 * Shared because four specs across three libs grew their own copy of this walk
 * and these two regexes (#372 review): the plugin grant locks, the plugin update
 * lock, the household member role lock, and the import-batch count.
 */

/**
 * Locates `prisma/models` by walking up from a spec's directory.
 *
 * A walk rather than a path relative to the workspace root, because specs run
 * from their own project directory and the depth differs per lib. Ten levels is
 * far more than any current lib needs and still terminates on a wrong guess.
 */
export function prismaModelsDir(from: string): string {
  let dir = from;

  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = join(dir, 'prisma', 'models');

    try {
      if (statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Not this level; keep walking toward the workspace root.
    }

    dir = resolve(dir, '..');
  }

  throw new Error(`Could not locate prisma/models by walking up from ${from}`);
}

/**
 * The text of one or more model files, concatenated.
 *
 * Paths are named by the caller rather than discovered: naming the wrong file
 * is worse than naming none, and a moved model should fail with the path it
 * looked for. An earlier version walked the directory and read everything,
 * which was slower and — worse — silently found nothing when a model moved.
 */
export function readPrismaModels(from: string, ...relativePaths: string[]): string {
  const dir = prismaModelsDir(from);

  return relativePaths.map((file) => readFileSync(join(dir, file), 'utf8')).join('\n');
}

/** The body of one `model` or `enum` block, or undefined when it is absent. */
export function prismaBlock(schema: string, kind: 'model' | 'enum', name: string): string | undefined {
  return new RegExp(`${kind}\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(schema)?.[1];
}

/**
 * The `@@map` name of a model or enum, or its declared name when unmapped.
 *
 * Scoped to the named block rather than regexing the whole file: a file holding
 * two models would otherwise answer with whichever `@@map` came first, and be
 * right only by accident.
 */
export function prismaTable(schema: string, kind: 'model' | 'enum', name: string): string {
  const body = prismaBlock(schema, kind, name);

  if (body === undefined) {
    throw new Error(`No ${kind} ${name} in the Prisma models read`);
  }

  return /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? name;
}

/** The `@map` name of one field, or the field name when unmapped. */
export function prismaColumn(schema: string, model: string, field: string): string {
  const body = prismaBlock(schema, 'model', model);

  if (body === undefined) {
    throw new Error(`No model ${model} in the Prisma models read`);
  }

  const line = new RegExp(`^\\s*${field}\\b.*$`, 'm').exec(body)?.[0] ?? '';

  return /@map\("([^"]+)"\)/.exec(line)?.[1] ?? field;
}
