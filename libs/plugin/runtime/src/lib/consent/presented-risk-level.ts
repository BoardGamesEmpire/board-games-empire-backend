import { RiskLevel } from '@bge/database';
import type { PermissionCheckOrigin } from '@boardgamesempire/plugin-manifest';

/**
 * A requested permission's risk as a consent surface shows it (#59): the
 * catalog's risk when the check has a row. Without one, a check on a declared
 * permission is `Low`, the only risk a declared permission's row can hold, so
 * the row install or activation creates will hold nothing else. A core check
 * with no row is `null`: its risk is unknowable, and a grant over it confers
 * nothing.
 *
 * The consent presentation and the artifact step both use it, so the two
 * cannot order the rule differently (#1094).
 */
export const presentedRiskLevel = (
  origin: PermissionCheckOrigin,
  catalogRisk: RiskLevel | null | undefined,
): RiskLevel | null => catalogRisk ?? (origin === 'plugin' ? RiskLevel.Low : null);
