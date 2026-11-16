import { indent, type PlanReport } from '../catalog/catalog-plan-report';
import type { MigrationState } from './migration-state';

/**
 * The second of `divergedFixLines`, alone: the fix that holds before this
 * build's migrations have applied, when deleting a row would still be early
 * (#1148).
 */
export const DEVELOPMENT_DATABASE_RESET_LINE =
  "On a development database, for another branch's migration left by switching branches over it, " +
  "`npm run db:reset` rebuilds the database from this build's migrations, deleting its data.";

/**
 * The schema half of what `npm run db:plan` prints (#236), first, as the boot
 * reads it first: `_prisma_migrations` against the migration manifest this
 * build was generated from, classified as the boot classifies it. Same
 * conventions as the catalog's `describePlanReport` and the ledger's: a
 * refusal leads, the closing line says the state in one word, and the exit
 * code is 0 for nothing to do, 1 for work the next boot would do, 2 for a
 * boot that would refuse. Over `behind` and `failed` the CLI prints this
 * alone: the api would apply the migrations before any seed, or refuse, and
 * a plan of the catalog over the tables as they stand would describe writes
 * against columns about to change, or fail on ones not yet created. Over
 * `ahead` the CLI goes on to plan the catalog as `db:seed`'s preview and says
 * the data migrations are not planned; the boot skips both, so this report's
 * code is the exit code. Over `diverged` the boot runs both, as over a
 * database in sync, so the CLI plans both and their codes count (#1148).
 */
export function describeSchemaReport(state: MigrationState): PlanReport {
  switch (state.kind) {
    case 'in-sync':
      return { lines: ['Schema: in sync with this build.'], exitCode: 0 };
    case 'behind':
      return { lines: behindLines(state), exitCode: 1 };
    case 'ahead':
      return { lines: aheadLines(state), exitCode: 0 };
    case 'diverged':
      return { lines: divergedLines(state), exitCode: 0 };
    case 'failed':
      return { lines: failedLines(state), exitCode: 2 };
  }
}

function behindLines({ pending, unknown }: MigrationState): string[] {
  const lines = [
    `The next api boot would apply ${pending.length} migration(s) before the seeds, in this order:`,
    ...pending.map(indent),
  ];
  // The run that applies the pending migrations comes after every row already
  // in the ledger, so each unknown one then reads as a rewritten history
  // (#1148): the boot warns and runs the seeds. A pending migration that
  // repeats a renamed one's changes fails on them. No DELETE yet: until the
  // pending migrations apply, this build's migrations hold none of a renamed
  // one's changes, and deleting its row would not stop the repeat failing.
  if (unknown.length > 0) {
    lines.push(
      '',
      `The database also holds ${unknown.length} migration(s) this build does not know, applied before the ` +
        'migrations above would be: after applying them, the boot finds the migration history rewritten, warns, and ' +
        'runs the seeds. If one was renamed and a migration above repeats its changes, applying fails on them.',
      ...unknown.map(indent),
      'Delete no row yet: plan again after the migrations above apply, and this report names each rewritten ' +
        "migration's row and how to delete it.",
      DEVELOPMENT_DATABASE_RESET_LINE,
    );
  }
  lines.push(
    '',
    'The catalog and the data migrations are not planned here: the boot plans them over the migrated schema, and ' +
      'the tables and columns the migrations add are not there yet. `npm run db:migrate` applies them from the CLI; ' +
      'plan again after it.',
    '',
    `Schema: behind by ${pending.length} migration(s).`,
  );
  return lines;
}

function aheadLines({ unknown, diverged }: MigrationState): string[] {
  const rewritten = new Set(diverged);
  const newer = unknown.filter((name) => !rewritten.has(name));
  const lines = [`The database holds ${newer.length} migration(s) this build does not know:`, ...newer.map(indent)];
  if (diverged.length > 0) {
    lines.push('', ...divergedHeadLines(diverged), ...divergedFixLines(diverged));
  }

  lines.push(
    '',
    'The next api boot would warn and boot, skipping the seeds and the data migrations: the newer build owns the ' +
      'data. The catalog plan that follows is what `npm run db:seed` would write; the boot would write none of it, ' +
      'so it does not count toward the exit code.',
    '',
    `Schema: ahead by ${newer.length} migration(s); the boot skips the seeds and the data migrations.`,
  );
  return lines;
}

function divergedLines({ diverged }: MigrationState): string[] {
  return [
    ...divergedHeadLines(diverged),
    ...divergedFixLines(diverged),
    '',
    'The next api boot would warn and boot, running the seeds and the data migrations, as over a database in sync: ' +
      "this build's migrations are the latest the database ran. The plans that follow are what it would write.",
    '',
    `Schema: diverged by ${diverged.length} migration(s); the boot runs the seeds and the data migrations.`,
  ];
}

function divergedHeadLines(diverged: readonly string[]): string[] {
  return [
    `The database holds ${diverged.length} migration(s) this build does not know, applied before a later run of ` +
      'migrations it does know: the migration history was rewritten.',
    ...diverged.map(indent),
  ];
}

/**
 * The two ways out of a rewritten migration history (#1148), shared by
 * `db:plan` and the boot's warning. A migration renamed or deleted on master
 * whose changes this build's migrations already hold: delete its row. Another
 * branch's migration, left by switching branches over one development
 * database: rebuild the database from this build's migrations. The boot's
 * warning reaches production logs too, so the rebuild says it is for a
 * development database: the image has no npm scripts, and the rebuild deletes
 * the data. A quote in a name is doubled, so the DELETE runs as printed:
 * `migrate deploy` applies a hand-named directory as it is.
 */
export function divergedFixLines(names: readonly string[]): string[] {
  return [
    "For one renamed or deleted, whose changes this build's migrations already made, delete its ledger row: " +
      names
        .map((name) => `DELETE FROM _prisma_migrations WHERE migration_name = '${name.replaceAll("'", "''")}';`)
        .join(' '),
    DEVELOPMENT_DATABASE_RESET_LINE,
  ];
}

function failedLines({ failed }: MigrationState): string[] {
  return [
    `The next api boot would REFUSE to boot: ${failed.length} migration(s) started but did not finish.`,
    ...failed.map(indent),
    '',
    'A `prisma migrate deploy` that is still running looks the same: if one is, let it finish and plan again. ' +
      'Otherwise inspect the database, then mark each one rolled back with ' +
      failed.map((name) => `\`prisma migrate resolve --rolled-back ${name}\``).join(' and ') +
      ' (or `--applied` if its statements did complete). Nothing is planned over a half-applied schema.',
    '',
    'Schema: the boot would refuse.',
  ];
}
