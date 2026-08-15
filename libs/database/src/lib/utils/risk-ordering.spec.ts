import { RiskLevel } from '../client';
import { riskCovers } from './risk-ordering';

describe('riskCovers', () => {
  it('covers when the decided risk equals the current risk', () => {
    expect(riskCovers(RiskLevel.Medium, RiskLevel.Medium)).toBe(true);
  });

  it('covers when the decided risk exceeds the current risk', () => {
    expect(riskCovers(RiskLevel.Critical, RiskLevel.Low)).toBe(true);
  });

  it('does not cover when the current risk has escalated past the decision', () => {
    expect(riskCovers(RiskLevel.Medium, RiskLevel.Critical)).toBe(false);
  });

  it('orders the full ladder Low < Medium < High < Critical', () => {
    const ladder = [RiskLevel.Low, RiskLevel.Medium, RiskLevel.High, RiskLevel.Critical];

    ladder.forEach((decided, decidedRank) => {
      ladder.forEach((current, currentRank) => {
        expect(riskCovers(decided, current)).toBe(decidedRank >= currentRank);
      });
    });
  });
});
