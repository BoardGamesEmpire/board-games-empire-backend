import { Action, ResourceType, RiskLevel, SystemRole } from '../client';
import { describePlanReport } from './catalog-plan-report';
import type { ReconcilePlan } from './catalog-reconcile-plan';

// What `npm run db:plan` prints and how it exits, over plans built by hand:
// the reading is the CLI's whole contract, and the CLI itself is one thin
// call over this (apps/api-e2e/src/database/plan-cli.spec.ts spawns it).

const emptyPlan = (): ReconcilePlan => ({
  permissions: { create: [], update: [], revive: [], retire: [], skipped: [], retained: [], conflicts: [] },
  roles: { create: [], update: [], skipped: [], orphans: [], conflicts: [] },
  rolePermissions: { create: [], delete: [], retained: [], conflicts: [] },
});

const pending = (): ReconcilePlan => ({
  ...emptyPlan(),
  permissions: {
    ...emptyPlan().permissions,
    create: [
      { action: Action.read, subject: ResourceType.Game, slug: 'read:game', riskLevel: RiskLevel.Low, reason: 'x' },
    ],
  },
  rolePermissions: {
    ...emptyPlan().rolePermissions,
    create: [{ roleName: SystemRole.User, permissionSlug: 'read:game' }],
  },
});

describe('describePlanReport', () => {
  it('says a converged catalog has nothing to write and exits 0', () => {
    const report = describePlanReport(emptyPlan());

    expect(report.exitCode).toBe(0);
    expect(report.lines).toContain(
      '  Catalog reconcile: permissions +0 ~0 revived 0 retired 0; roles +0 ~0; grants +0 -0',
    );
    expect(report.lines).toContain('Catalog: converged, nothing to write.');
    expect(report.lines.at(-1)).toBe('Catalog: converged, nothing to write.');
  });

  it('describes pending writes as what the next reconcile would do and exits 1', () => {
    const report = describePlanReport(pending());

    expect(report.exitCode).toBe(1);
    expect(report.lines[0]).toMatch(/^Plan only; nothing is written\./);
    expect(report.lines).toContain(
      '  Catalog reconcile: permissions +1 ~0 revived 0 retired 0; roles +0 ~0; grants +1 -0',
    );
    expect(report.lines).toContain('Catalog: 2 row(s) to write.');
  });

  it('leads with the refusal when a plugin owns a claimed row, files the writes under "once resolved", and exits 2', () => {
    const plan: ReconcilePlan = {
      ...pending(),
      permissions: { ...pending().permissions, conflicts: [{ slug: 'read:plugin:thing' }] },
    };

    const report = describePlanReport(plan);

    expect(report.exitCode).toBe(2);
    expect(report.lines[0]).toMatch(/would REFUSE and write nothing/);
    expect(report.lines[1]).toContain("permission 'read:plugin:thing' is Plugin-owned but the manifest defines it");
    const resolved = report.lines.findIndex((line) => /once .* resolved/i.test(line));
    const summary = report.lines.findIndex((line) => line.includes('Catalog reconcile: permissions +1'));
    expect(resolved).toBeGreaterThan(1);
    expect(summary).toBeGreaterThan(resolved);
    expect(report.lines).toContain('Catalog: the reconcile would refuse.');
  });
});
