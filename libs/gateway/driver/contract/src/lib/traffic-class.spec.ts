import * as proto from '@boardgamesempire/proto-gateway';
import { trafficClassOf } from './traffic-class.js';

/**
 * A request is background only when it says so. Unset, UNSPECIFIED and a
 * value from a newer server all read as live, so a DataGateway never holds
 * back a call a user may be waiting on (#925).
 */
describe('trafficClassOf', () => {
  it('reads background as background', () => {
    expect(trafficClassOf({ trafficClass: proto.TrafficClass.TRAFFIC_CLASS_BACKGROUND })).toBe(
      proto.TrafficClass.TRAFFIC_CLASS_BACKGROUND,
    );
  });

  it.each([
    ['live', proto.TrafficClass.TRAFFIC_CLASS_LIVE],
    ['unspecified', proto.TrafficClass.TRAFFIC_CLASS_UNSPECIFIED],
    ['absent', undefined],
    ['unknown', 99 as unknown as proto.TrafficClass],
  ])('reads %s as live', (_label, trafficClass) => {
    expect(trafficClassOf({ trafficClass })).toBe(proto.TrafficClass.TRAFFIC_CLASS_LIVE);
  });
});
