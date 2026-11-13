import * as proto from '@boardgamesempire/proto-gateway';

/**
 * The traffic class a request asks for. Only background is background:
 * unset, UNSPECIFIED and a value this build doesn't know are live, so a
 * DataGateway never holds back a call a user may be waiting on (#925).
 */
export function trafficClassOf(request: {
  trafficClass?: proto.TrafficClass;
}): proto.TrafficClass.TRAFFIC_CLASS_LIVE | proto.TrafficClass.TRAFFIC_CLASS_BACKGROUND {
  return request.trafficClass === proto.TrafficClass.TRAFFIC_CLASS_BACKGROUND
    ? proto.TrafficClass.TRAFFIC_CLASS_BACKGROUND
    : proto.TrafficClass.TRAFFIC_CLASS_LIVE;
}
