import type { RiskLevel } from '../client';

/**
 * Ordering over `RiskLevel`, and the single question every consent check
 * asks of a stored decision: does the risk the unit consented under still
 * cover the risk the permission carries today (D-X)?
 *
 * Lives here (rather than in the plugin runtime, its original home) because
 * consumers now span two dependency islands: the runtime's escalation
 * comparison / suspension pass / D-AR re-enable check, and the permissions
 * lib's plugin grant read path (#60 D60-2) — which the runtime imports and
 * therefore must not be imported by. `@bge/database` is beneath both.
 *
 * Explicit rather than derived from enum declaration order: the Prisma enum
 * is a nominal set, and a consent gate must not change meaning because
 * someone alphabetized a schema file.
 */
const RISK_RANK: Readonly<Record<RiskLevel, number>> = {
  Low: 0,
  Medium: 1,
  High: 2,
  Critical: 3,
};

export const riskCovers = (decidedRiskLevel: RiskLevel, currentRiskLevel: RiskLevel): boolean =>
  RISK_RANK[decidedRiskLevel] >= RISK_RANK[currentRiskLevel];
