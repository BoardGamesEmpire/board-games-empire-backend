import type { Subscription } from 'rxjs';

export interface WsClientData {
  userId?: string;

  /**
   * correlationId → active gRPC stream subscription
   */
  activeSearches: Map<string, Subscription>;
}
