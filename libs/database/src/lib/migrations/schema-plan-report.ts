import { indent, type PlanReport } from '../catalog/catalog-plan-report';
import type { MigrationState } from './migration-state';

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
 * `ahead` the CLI goes on to plan both DML halves as `db:seed`'s preview,
 * but the boot skips them, so this report's code is the exit code.
 */
export function describeSchemaReport(state: MigrationState): PlanReport {
  switch (state.kind) {
    case 'in-sync':
      return { lines: ['Schema: in sync with this build.'], exitCode: 0 };
    case 'behind':
      return { lines: behindLines(state), exitCode: 1 };
    case 'ahead':
      return { lines: aheadLines(state), exitCode: 0 };
    case 'failed':
      return { lines: failedLines(state), exitCode: 2 };
  }
}

function behindLines({ pending, unknown }: MigrationState): string[] {
  const lines = [
    `The next api boot would apply ${pending.length} migration(s) before the seeds, in this order:`,
    ...pending.map(indent),
  ];
  if (unknown.length > 0) {
    lines.push(
      '',
      `The database also holds ${unknown.length} migration(s) this build does not know, left alone:`,
      ...unknown.map(indent),
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

function aheadLines({ unknown }: MigrationState): string[] {
  return [
    `The database holds ${unknown.length} migration(s) this build does not know:`,
    ...unknown.map(indent),
    '',
    'The next api boot would warn and boot, skipping the seeds and the data migrations: the newer build owns the ' +
      'data. What follows is what `npm run db:seed` would write; the boot would write none of it, so it does not ' +
      'count toward the exit code.',
    '',
    `Schema: ahead by ${unknown.length} migration(s); the boot skips the seeds and the data migrations.`,
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
