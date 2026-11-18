import { z } from 'zod';

/**
 * Event published to Redis pub/sub when a gateway's configuration changes
 * in a way that affects connection behavior. Subscribers compare configHash
 * against their cached version to decide whether to invalidate.
 */
export const gatewayConfigEventSchema = z.object({
  /**
   * Categorical change type — informational for listeners
   */
  changeType: z.enum(['created', 'updated', 'deleted', 'disabled', 'reconnect-requested']),

  /**
   * Hash of the new config — receivers compare against their cached hash
   */
  configHash: z.string(),

  gatewayId: z.string(),

  /**
   * Timestamp in milliseconds since epoch
   */
  timestamp: z.number(),
});

export type GatewayConfigEvent = z.infer<typeof gatewayConfigEventSchema>;

// The EventEmitter2 auto-disable payload moved to a MutationEvent class:
// see `../events/gateway-registry.events` (#57 emit-site migration).
