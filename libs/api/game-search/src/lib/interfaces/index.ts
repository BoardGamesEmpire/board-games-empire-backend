import type { Subscription } from 'rxjs';

export interface WsClientData {
  /**
   * correlationId → active gRPC stream subscription
   */
  activeSearches: Map<string, Subscription>;
}
