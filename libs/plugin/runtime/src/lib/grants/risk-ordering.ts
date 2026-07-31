import type { RiskLevel } from '@bge/database';

/**
 * Ordering over `RiskLevel`, and the single question every consent check
 * asks of a stored decision: does the risk the unit consented under still
 * cover the risk the permission carries today (D-X)?
 *
 * Lives in `grants/` rather than beside the update comparator because THREE
 * paths now ask it — the escalation comparison, the update's suspension
 * pass, and the D-AR re-enable check — and the last of those is C1 code that
 * must not depend on the C3 update module to answer a question about its own
 * grant rows.
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
