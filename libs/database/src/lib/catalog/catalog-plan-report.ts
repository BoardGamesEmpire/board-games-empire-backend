import { countMutations, type ReconcilePlan } from './catalog-reconcile-plan';
import { describeConflicts, describeDrift, describeWrites, summarizePlan } from './catalog-reconciler';

export interface PlanReport {
  readonly lines: readonly string[];
  /** 0 converged, 1 a reconcile would write, 2 a reconcile would refuse. */
  readonly exitCode: 0 | 1 | 2;
}

const indent = (line: string): string => `  ${line}`;

/**
 * What `npm run db:plan` prints, over a plan that nothing has applied (#236).
 * A refusal leads: the summary and the write lines are what a reconcile would
 * do, and when a plugin owns a row the manifest claims it does none of it, so
 * saying "would do this" first would mislead a reader who stops at the summary.
 */
export function describePlanReport(plan: ReconcilePlan): PlanReport {
  const conflicts = describeConflicts(plan);
  const drift = describeDrift(plan);
  const mutations = countMutations(plan);
  const lines: string[] = [];

  if (conflicts.length > 0) {
    lines.push(
      'The next reconcile would REFUSE and write nothing: the manifest claims rows a plugin owns.',
      ...conflicts.map(indent),
      '',
      'Once those are resolved, it would do this:',
    );
  } else {
    lines.push('Plan only; nothing is written. The next reconcile (an api boot, or `npm run db:seed`) would do this:');
  }
  lines.push(indent(summarizePlan(plan)), ...describeWrites(plan).map(indent));

  if (drift.length > 0) {
    lines.push('', 'Rows the reconcile leaves alone:', ...drift.map(indent));
  }

  lines.push(
    '',
    conflicts.length > 0
      ? 'Catalog: the reconcile would refuse.'
      : mutations === 0
        ? 'Catalog: converged, nothing to write.'
        : `Catalog: ${mutations} row(s) to write.`,
    'Schema: this covers the catalog only; `npx prisma migrate status` reports pending migrations.',
  );

  return { lines, exitCode: conflicts.length > 0 ? 2 : mutations > 0 ? 1 : 0 };
}
