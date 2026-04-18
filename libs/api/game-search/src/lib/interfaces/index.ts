import type { SearchGameResult } from '@board-games-empire/proto-gateway';
import type { Subscription } from 'rxjs';

export interface WsClientData {
  userId?: string;

  /**
   * correlationId → active gRPC stream subscription
   */
  activeSearches: Map<string, Subscription>;
}

export interface SearchGamesResponse {
  correlationId: string;
  results: SearchGameResult[];
}
