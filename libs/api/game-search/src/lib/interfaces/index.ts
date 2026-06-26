import type { BaseClientData } from '@bge/shared';
import type { SearchGameResult } from '@boardgamesempire/proto-gateway';
import type { Subscription } from 'rxjs';

export interface WsClientData extends BaseClientData {
  /**
   * correlationId → active gRPC stream subscription
   */
  activeSearches: Map<string, Subscription>;
}

export interface SearchGamesResponse {
  correlationId: string;
  results: SearchGameResult[];
}
