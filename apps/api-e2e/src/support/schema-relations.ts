import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceRoot } from './shipped-sql';

/**
 * The models that carry a foreign key to a given parent, read out of the Prisma
 * schema.
 *
 * This exists for one caller and one reason: an INSERT into a table with an FK
 * to `plugins` takes `FOR KEY SHARE` on the parent row from the
 * referential-integrity trigger, and nothing in the application source says so
 * (#398, #399). A check over that class has to know which tables are in it —
 * and a hand-kept list of them is the same shape of blind spot one level out.
 * Four tables carry that FK today. The fifth is the one this module exists for.
 *
 * The names are read from the SCHEMA rather than derived from the model name.
 * Prisma's table name is whatever `@@map` says, so a model without one, or one
 * whose map disagrees with the pluralisation a reader would guess, is a lock
 * clause naming a table that does not exist — and a stage pattern that matches
 * no relation matches nothing, which passes.
 */

/** Where the models live, relative to the workspace root. */
const MODELS_DIR = join('prisma', 'models');

/** A model declaring a foreign key to some parent model. */
export interface ChildRelation {
  /** The Prisma model, e.g. `PluginGrant`. */
  readonly model: string;

  /** The Postgres table, from `@@map` — what a `FROM …` clause names. */
  readonly table: string;

  /** The Prisma client property, e.g. `pluginGrant` — what a write names. */
  readonly accessor: string;

  /** The scalar field holding the key, e.g. `pluginId`. */
  readonly foreignKey: string;

  /** The schema file it was declared in, so a refusal can point at it. */
  readonly file: string;
}

/** A model block lifted from a schema file, before anything is asked of it. */
interface ModelBlock {
  readonly name: string;
  readonly body: string;
  readonly file: string;
}

const MODEL_NAME = /^[A-Z][A-Za-z0-9_]*$/;

/**
 * Every model carrying an FK to `parentModel`, in schema-file order.
 *
 * Refuses rather than returns a short answer. A scan that finds no files, a
 * child with no `@@map`, or a parent nothing references are all shapes where
 * the honest result is indistinguishable from a broken reader — and this
 * module's whole value is being the thing that notices a table nobody added to
 * a list, so a silent empty result would be worse than no check at all.
 */
/**
 * Kept per parent, the way the audit that consumes this keeps its own result.
 * Reading the schema walks 17 directories, strips comments line by line and
 * runs the model regex over every file, for an answer that cannot change
 * within a run — and the callers ask more than once.
 */
const derived = new Map<string, readonly ChildRelation[]>();

export function childRelationsOf(parentModel: string): readonly ChildRelation[] {
  const cached = derived.get(parentModel);

  if (cached !== undefined) {
    return cached;
  }

  const children = readChildRelations(parentModel);

  derived.set(parentModel, children);

  return children;
}

function readChildRelations(parentModel: string): readonly ChildRelation[] {
  if (!MODEL_NAME.test(parentModel)) {
    // This builds a regex below, so anything else widens the match instead of
    // failing — `Plugin|User` reads as one model and would find both.
    throw new Error(`'${parentModel}' is not a plain Prisma model name.`);
  }

  const blocks = readModelBlocks();

  if (blocks.length === 0) {
    throw new Error(
      `No Prisma models found under ${MODELS_DIR}. This reader is what tells the FK-implied-lock check which ` +
        `tables are in its class, so finding nothing is a broken reader, not an empty schema.`,
    );
  }

  const relation = new RegExp(String.raw`^\s*\w+\s+${parentModel}\??\s+@relation\(\s*fields:\s*\[\s*(\w+)\s*\]`, 'gm');
  const children: ChildRelation[] = [];

  for (const block of blocks) {
    const keys = [...block.body.matchAll(relation)].map((match) => match[1]);

    if (keys.length === 0) {
      continue;
    }

    if (keys.length > 1) {
      // Two keys into the same parent, and no way to say which one the implied
      // lock follows. Guessing is the judgement this module refuses to make.
      throw new Error(
        `Model '${block.name}' (${block.file}) declares ${keys.length} relations to '${parentModel}' ` +
          `(${keys.join(', ')}), so this reader cannot say which key carries the implied parent lock.`,
      );
    }

    const [foreignKey] = keys;
    const mapped = /@@map\("([^"]+)"\)/.exec(block.body);

    if (mapped?.[1] === undefined) {
      throw new Error(
        `Model '${block.name}' (${block.file}) carries an FK to '${parentModel}' but declares no @@map, so its ` +
          `Postgres table name is not stated anywhere this can read. A lock clause names the TABLE, and a ` +
          `pattern built from a guessed pluralisation matches nothing — which passes.`,
      );
    }

    if (foreignKey === undefined) {
      throw new Error(`Model '${block.name}' (${block.file}) matched a relation to '${parentModel}' with no field.`);
    }

    children.push({
      model: block.name,
      table: mapped[1],
      // Prisma's client property is the model name with a lowercased initial.
      accessor: block.name.charAt(0).toLowerCase() + block.name.slice(1),
      foreignKey,
      file: block.file,
    });
  }

  if (children.length === 0) {
    throw new Error(
      `No model under ${MODELS_DIR} declares an FK to '${parentModel}'. Either the parent was renamed or this ` +
        `reader stopped recognising the relation syntax — both leave the check asserting nothing.`,
    );
  }

  return children;
}

function readModelBlocks(): readonly ModelBlock[] {
  const root = join(workspaceRoot(), MODELS_DIR);
  const blocks: ModelBlock[] = [];

  for (const file of schemaFiles(root)) {
    const source = stripComments(readFileSync(join(root, file), 'utf8'));
    // Non-greedy to the first closing brace in column 0, which is how every
    // model in this schema is laid out and what the `m` flag anchors.
    const model = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;

    for (const match of source.matchAll(model)) {
      const [, name, body] = match;

      if (name === undefined || body === undefined) {
        continue;
      }

      if (/^model\s/m.test(body)) {
        // The lift ends at the first `}` in column 0. A model that closes
        // indented would swallow its neighbour, and the merged block carries
        // TWO `@@map`s — of which this reader would take the first, naming one
        // model with another's table. Refusing beats that quietly.
        throw new Error(
          `Model '${name}' in ${file} appears to contain another model declaration, which means its closing brace ` +
            `was not found where this reader expects it (column 0). Two models read as one name the wrong table.`,
        );
      }

      blocks.push({ name, body, file: join(MODELS_DIR, file) });
    }
  }

  return blocks;
}

function schemaFiles(root: string): readonly string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.prisma'))
    .sort();
}

/**
 * Drops whole-line comments, which is every comment shape this schema uses.
 *
 * Load-bearing rather than tidy: these models document their own relations in
 * `///` prose above the field, so a reader that kept comments would find
 * relations that are descriptions of relations. Only lines that OPEN with the
 * marker are dropped — a trailing comment survives, which can only ever add a
 * child, and an added child fails loudly against the pinned literal rather
 * than quietly removing one.
 */
function stripComments(source: string): string {
  return source
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line))
    .join('\n');
}
