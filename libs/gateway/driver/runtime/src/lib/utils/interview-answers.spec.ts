import { DataGatewayCapability } from '@bge/database';
import * as proto from '@boardgamesempire/proto-gateway';
import { toInterviewAnswers } from './interview-answers';

const PING: proto.GatewayPingResponse = {
  correlationId: 'ping',
  timestampMs: 0n,
  gatewayName: 'stub',
  gatewayVersion: '1.0.0',
};

/** A Describe declaring `capabilities`, and the batch limit when given. Over gRPC an unset field arrives missing. */
const describing = (capabilities: proto.Capability[], fetchGamesMaxIds?: number): proto.DescribeResponse =>
  ({
    correlationId: 'describe',
    capabilities,
    filterableAxes: [],
    fetchGamesMaxIds,
  }) as Partial<proto.DescribeResponse> as proto.DescribeResponse;

const { CAPABILITY_FETCH: FETCH, CAPABILITY_FETCH_GAMES: FETCH_GAMES } = proto.Capability;

/**
 * FetchGames needs its batch limit: without one the server can't size a
 * call, so the capability isn't stored and nothing routes to it (#925).
 */
describe('toInterviewAnswers batch limit', () => {
  it('stores the batch limit with FetchGames', () => {
    const answers = toInterviewAnswers(describing([FETCH, FETCH_GAMES], 250), PING);

    expect(answers.capabilities).toEqual([DataGatewayCapability.Fetch, DataGatewayCapability.FetchGames]);
    expect(answers.fetchGamesMaxIds).toBe(250);
  });

  it.each([
    ['absent', undefined],
    ['zero', 0],
    ['negative', -1],
    ['not whole', 2.5],
  ])('drops FetchGames when the batch limit declared is %s', (_label, fetchGamesMaxIds) => {
    const answers = toInterviewAnswers(describing([FETCH, FETCH_GAMES], fetchGamesMaxIds), PING);

    expect(answers.capabilities).toEqual([DataGatewayCapability.Fetch]);
    expect(answers.fetchGamesMaxIds).toBeNull();
  });

  it('ignores a batch limit without FetchGames', () => {
    const answers = toInterviewAnswers(describing([FETCH], 250), PING);

    expect(answers.capabilities).toEqual([DataGatewayCapability.Fetch]);
    expect(answers.fetchGamesMaxIds).toBeNull();
  });
});
