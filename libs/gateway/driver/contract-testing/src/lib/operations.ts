import * as proto from '@boardgamesempire/proto-gateway';

/** Every operation a DataGateway can declare, each with cases in the contract suite. */
export const OPERATIONS: readonly proto.Capability[] = [
  proto.Capability.CAPABILITY_SEARCH,
  proto.Capability.CAPABILITY_FETCH,
  proto.Capability.CAPABILITY_FETCH_EXPANSIONS,
  proto.Capability.CAPABILITY_LIST_LANGUAGES,
  proto.Capability.CAPABILITY_LIST_PLATFORMS,
  proto.Capability.CAPABILITY_LIST_CATEGORIES,
  proto.Capability.CAPABILITY_LIST_MECHANICS,
];
