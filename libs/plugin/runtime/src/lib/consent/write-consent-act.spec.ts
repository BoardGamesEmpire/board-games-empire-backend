import {
  PluginConsentActKind,
  PluginGrantScope,
  PluginGrantStatus,
  RiskLevel,
  type PluginGrant,
  type Prisma,
} from '@bge/database';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import type { ConsentActDecision, ConsentActPresentation } from './plugin-consent-act.types';
import { writeConsentAct, type ConsentActWrite } from './write-consent-act';

describe('writeConsentAct', () => {
  const DECIDED_AT = new Date('2026-11-17T10:00:00.000Z');

  const presentation: ConsentActPresentation = {
    locale: 'en',
    source: 'active',
    checks: [
      {
        slug: 'feedback:read',
        required: false,
        feature: null,
        riskLevel: RiskLevel.Low,
        reason: 'Reads submitted feedback.',
        usedFallback: false,
        outcome: 'granted',
      },
    ],
  };

  const row = (permissionSlug: string, status: PluginGrantStatus, decidedRiskLevel: RiskLevel): PluginGrant => ({
    id: `grant-${permissionSlug}`,
    pluginId: 'plugin-1',
    scopeType: PluginGrantScope.Household,
    scopeId: 'household-1',
    permissionSlug,
    status,
    decidedById: 'admin-0',
    actId: 'act-0',
    decidedAt: new Date(0),
    decidedRiskLevel,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  const decision = (
    permissionSlug: string,
    status: PluginGrantStatus = PluginGrantStatus.Granted,
    decidedRiskLevel: RiskLevel = RiskLevel.Low,
  ): ConsentActDecision => ({ permissionSlug, status, decidedRiskLevel });

  const input = (overrides: Partial<ConsentActWrite> = {}): ConsentActWrite => ({
    pluginId: 'plugin-1',
    pluginSlug: 'demo-sink',
    scopeType: PluginGrantScope.Household,
    scopeId: 'household-1',
    kind: PluginConsentActKind.Toggle,
    manifestVersion: '1.2.0',
    manifestSha256: 'sha-active',
    stagingId: null,
    presentation,
    decisions: [decision('feedback:read')],
    standingBySlug: new Map(),
    actorId: 'admin-1',
    decidedAt: DECIDED_AT,
    correlationId: 'corr-1',
    ...overrides,
  });

  let db: MockDatabaseService;

  beforeEach(() => {
    db = createMockDatabaseService();

    db.pluginConsentAct.create.mockImplementation((({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'act-1', createdAt: new Date(0), ...data })) as never);
    db.pluginGrant.upsert.mockImplementation((({
      create,
    }: {
      create: Omit<PluginGrant, 'id' | 'createdAt' | 'updatedAt'>;
    }) =>
      Promise.resolve({
        ...create,
        id: `grant-${create.permissionSlug}`,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      })) as never);
  });

  const write = (overrides: Partial<ConsentActWrite> = {}) =>
    writeConsentAct(db as unknown as Prisma.TransactionClient, input(overrides));

  it('creates one act carrying the unit, kind, manifest, presentation, actor, time and correlation (#1152)', async () => {
    const written = await write();

    expect(db.pluginConsentAct.create).toHaveBeenCalledTimes(1);
    expect(db.pluginConsentAct.create).toHaveBeenCalledWith({
      data: {
        pluginId: 'plugin-1',
        pluginSlug: 'demo-sink',
        scopeType: PluginGrantScope.Household,
        scopeId: 'household-1',
        kind: PluginConsentActKind.Toggle,
        manifestVersion: '1.2.0',
        manifestSha256: 'sha-active',
        stagingId: null,
        presentation,
        decidedById: 'admin-1',
        decidedAt: DECIDED_AT,
        correlationId: 'corr-1',
      },
    });
    expect(written.act.id).toBe('act-1');
  });

  it('records the staging the act answered, and null for an act on the active manifest (#1152)', async () => {
    await write({ kind: PluginConsentActKind.Review, manifestSha256: 'sha-staged', stagingId: 'staging-a' });
    await write();

    const acts = db.pluginConsentAct.create.mock.calls.map(([args]) => args.data) as unknown as Record<
      string,
      unknown
    >[];

    // A rejection of the staging deletes the decisions whose act names it.
    expect(acts.map((act) => act['stagingId'])).toEqual(['staging-a', null]);
  });

  it('upserts every decision in the order given, each naming the act (#1152)', async () => {
    const decisions = [
      decision('feedback:read'),
      decision('plugin|demo-sink|manage:digest'),
      decision('update:calendar', PluginGrantStatus.Denied),
    ];

    const written = await write({ decisions });

    const upserts = db.pluginGrant.upsert.mock.calls.map(([args]) => args) as unknown as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
      where: { pluginId_scopeType_scopeId_permissionSlug: Record<string, string> };
    }[];

    expect(upserts.map((upsert) => upsert.where.pluginId_scopeType_scopeId_permissionSlug.permissionSlug)).toEqual(
      decisions.map((planned) => planned.permissionSlug),
    );

    for (const [index, upsert] of upserts.entries()) {
      const fields = {
        status: decisions[index].status,
        decidedRiskLevel: decisions[index].decidedRiskLevel,
        decidedById: 'admin-1',
        decidedAt: DECIDED_AT,
        actId: 'act-1',
      };

      expect(upsert.where.pluginId_scopeType_scopeId_permissionSlug).toEqual({
        pluginId: 'plugin-1',
        scopeType: PluginGrantScope.Household,
        scopeId: 'household-1',
        permissionSlug: decisions[index].permissionSlug,
      });
      expect(upsert.create).toEqual({
        pluginId: 'plugin-1',
        scopeType: PluginGrantScope.Household,
        scopeId: 'household-1',
        permissionSlug: decisions[index].permissionSlug,
        ...fields,
      });
      expect(upsert.update).toEqual(fields);
    }

    // The act first, so every decision's row can name it.
    expect(db.pluginConsentAct.create.mock.invocationCallOrder[0]).toBeLessThan(
      db.pluginGrant.upsert.mock.invocationCallOrder[0],
    );
    expect(written.rows.map((upserted) => upserted.permissionSlug)).toEqual(
      decisions.map((planned) => planned.permissionSlug),
    );
  });

  it('reports a decision as changed when no row stood or the row differs, and not when it stands (#1152)', async () => {
    const overturned = row('plugin|demo-sink|manage:digest', PluginGrantStatus.Granted, RiskLevel.Low);
    const standing = row('update:calendar', PluginGrantStatus.Granted, RiskLevel.Low);

    const written = await write({
      decisions: [
        decision('feedback:read'),
        decision('plugin|demo-sink|manage:digest', PluginGrantStatus.Denied),
        decision('update:calendar'),
      ],
      standingBySlug: new Map([
        [overturned.permissionSlug, overturned],
        [standing.permissionSlug, standing],
      ]),
    });

    expect(written.rows).toHaveLength(3);
    expect(written.changed).toHaveLength(2);
    expect(written.changed[0].before).toBeNull();
    expect(written.changed[0].after.permissionSlug).toBe('feedback:read');
    expect(written.changed[1].before).toBe(overturned);
    expect(written.changed[1].after).toMatchObject({
      permissionSlug: 'plugin|demo-sink|manage:digest',
      status: PluginGrantStatus.Denied,
      actId: 'act-1',
    });
  });
});
