import type { GameGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
import * as proto from '@boardgamesempire/proto-gateway';
import { concat, from, Observable, of, throwError } from 'rxjs';

export interface InMemoryGatewayFixtures {
  /** Reported as gateway_name on ping. */
  gatewayName?: string;

  /** fetchGame resolves against these by `externalId`. */
  games?: proto.GameData[];

  /** searchGames streams these (as RESULT frames) for ANY query, then SOURCE_DONE. */
  searchResults?: proto.GameSearchData[];

  /** fetchExpansions streams these per base externalId, then completes. */
  expansionsByBaseExternalId?: Record<string, proto.GameSearchData[]>;

  /** listLanguages returns these. */
  languages?: proto.GatewayLanguageEntry[];
}

/**
 * Fixture-backed in-process `GameGatewayDriver`.
 *
 * Dual purpose, mirroring the storage contract-testing pattern:
 *  1. Reference implementation the shared contract suite runs against —
 *     it encodes the expected semantics (clean not-found is a response,
 *     streams terminate, dispose is idempotent).
 *  2. Test double for registry/consumer specs: `failWith()` flips every RPC
 *     into an errored Observable so transport-agnostic failure tracking can
 *     be exercised without gRPC.
 */
export class InMemoryGatewayDriver implements GameGatewayDriver {
  private failure: Error | undefined;
  private disposedFlag = false;

  constructor(private readonly fixtures: InMemoryGatewayFixtures = {}) {}

  /** All subsequent RPCs error with `error` until {@link restore} is called. */
  failWith(error: Error): void {
    this.failure = error;
  }

  /** Clears a previously injected failure. */
  restore(): void {
    this.failure = undefined;
  }

  get disposed(): boolean {
    return this.disposedFlag;
  }

  ping(request: proto.GatewayPingRequest): Observable<proto.GatewayPingResponse> {
    return (
      this.failed() ??
      of<proto.GatewayPingResponse>({
        correlationId: request.correlationId ?? 'in-memory',
        timestampMs: BigInt(Date.now()),
        gatewayName: this.fixtures.gatewayName ?? 'in-memory-gateway',
        gatewayVersion: '0.0.0-test',
        supportedServices: ['SearchGames', 'FetchGame', 'FetchExpansions', 'ListLanguages'],
        languagePreferences: {
          acceptedRequestFormats: [],
          responseFormat: proto.LanguageCodeFormat.UNRECOGNIZED,
          passthroughRawLocale: false,
        },
      })
    );
  }

  check(): Observable<proto.HealthCheckResponse> {
    return this.failed() ?? of<proto.HealthCheckResponse>({ status: proto.HealthCheckResponse_ServingStatus.SERVING });
  }

  searchGames(request: proto.GatewaySearchRequest): Observable<proto.GatewaySearchResult> {
    const failed = this.failed<proto.GatewaySearchResult>();
    if (failed) {
      return failed;
    }

    const results = (this.fixtures.searchResults ?? []).map(
      (game): proto.GatewaySearchResult => ({
        correlationId: request.correlationId,
        status: proto.ResultStatus.RESULT_STATUS_RESULT,
        game,
      }),
    );

    return concat(
      from(results),
      of<proto.GatewaySearchResult>({
        correlationId: request.correlationId,
        status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE,
      }),
    );
  }

  fetchGame(request: proto.FetchGameRequest): Observable<proto.FetchGameResponse> {
    const failed = this.failed<proto.FetchGameResponse>();
    if (failed) {
      return failed;
    }

    const game = this.fixtures.games?.find((candidate) => candidate.externalId === request.externalId);

    // Clean not-found is a RESPONSE, never an errored stream — the contract
    // consumers rely on to keep healthy interactions out of auto-disable.
    if (!game) {
      return of<proto.FetchGameResponse>({
        correlationId: request.correlationId,
        status: proto.ResultStatus.RESULT_STATUS_ERROR,
        message: `No game found for externalId ${request.externalId}`,
      });
    }

    return of<proto.FetchGameResponse>({
      correlationId: request.correlationId,
      status: proto.ResultStatus.RESULT_STATUS_RESULT,
      game,
    });
  }

  fetchExpansions(request: proto.FetchExpansionsRequest): Observable<proto.GatewaySearchResult> {
    const failed = this.failed<proto.GatewaySearchResult>();
    if (failed) {
      return failed;
    }

    const expansions = this.fixtures.expansionsByBaseExternalId?.[request.baseExternalId] ?? [];

    return from(
      expansions.map(
        (game): proto.GatewaySearchResult => ({
          correlationId: request.correlationId,
          status: proto.ResultStatus.RESULT_STATUS_RESULT,
          game,
        }),
      ),
    );
  }

  listLanguages(request: proto.ListLanguagesRequest): Observable<proto.ListLanguagesResponse> {
    return (
      this.failed<proto.ListLanguagesResponse>() ??
      of<proto.ListLanguagesResponse>({
        correlationId: request.correlationId ?? 'in-memory',
        languages: this.fixtures.languages ?? [],
      })
    );
  }

  dispose(): void {
    // Idempotent by contract.
    this.disposedFlag = true;
  }

  private failed<T>(): Observable<T> | undefined {
    return this.failure ? throwError(() => this.failure as Error) : undefined;
  }
}
