import type { DataGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
import * as proto from '@boardgamesempire/proto-gateway';
import { concat, from, Observable, of, throwError } from 'rxjs';
import { OPERATIONS } from './operations.js';

export interface InMemoryGatewayFixtures {
  /** Reported as gateway_name on ping. */
  gatewayName?: string;

  /**
   * The operations describe declares, unless set every one the contract suite
   * has cases for. An operation left out answers UNIMPLEMENTED, as a
   * DataGateway may.
   */
  capabilities?: proto.Capability[];

  /** fetchGame resolves against these by `externalId`. */
  games?: proto.GameData[];

  /** searchGames streams these (as RESULT frames) for ANY query, then SOURCE_DONE. */
  searchResults?: proto.GameSearchData[];

  /** fetchExpansions streams these per base externalId, then completes. */
  expansionsByBaseExternalId?: Record<string, proto.GameSearchData[]>;

  /** listLanguages returns these. */
  languages?: proto.GatewayLanguageEntry[];
}

/** gRPC's status code for an operation a DataGateway doesn't implement. */
const UNIMPLEMENTED = 12;

/**
 * Fixture-backed in-process `DataGatewayDriver`.
 *
 * Dual purpose, mirroring the storage contract-testing pattern:
 *  1. Reference implementation the shared contract suite runs against —
 *     it encodes the expected semantics (clean not-found is a response,
 *     streams terminate, dispose is idempotent). An operation it doesn't
 *     declare answers UNIMPLEMENTED, as a DataGateway may.
 *  2. Test double for registry/consumer specs: `failWith()` flips every RPC
 *     into an errored Observable so transport-agnostic failure tracking can
 *     be exercised without gRPC.
 */
export class InMemoryGatewayDriver implements DataGatewayDriver {
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
      })
    );
  }

  check(): Observable<proto.HealthCheckResponse> {
    return this.failed() ?? of<proto.HealthCheckResponse>({ status: proto.HealthCheckResponse_ServingStatus.SERVING });
  }

  /** Declares its fixtures' capabilities, no coverage, BCP 47 language codes and plain text. */
  describe(request: proto.DescribeRequest): Observable<proto.DescribeResponse> {
    return (
      this.failed<proto.DescribeResponse>() ??
      of<proto.DescribeResponse>({
        correlationId: request.correlationId ?? 'in-memory',
        capabilities: [...this.capabilities],
        coverage: { platformTypes: [], contentTypes: [] },
        filterableAxes: [],
        languageCodeFormats: {
          acceptedRequestFormats: [proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47],
          responseFormat: proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47,
          passthroughSearchLanguage: false,
        },
        contentFormat: proto.ContentFormat.CONTENT_FORMAT_PLAIN_TEXT,
      })
    );
  }

  searchGames(request: proto.GatewaySearchRequest): Observable<proto.GatewaySearchResult> {
    const refused = this.refused<proto.GatewaySearchResult>(proto.Capability.CAPABILITY_SEARCH);
    if (refused) {
      return refused;
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
    const refused = this.refused<proto.FetchGameResponse>(proto.Capability.CAPABILITY_FETCH);
    if (refused) {
      return refused;
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
    const refused = this.refused<proto.GatewaySearchResult>(proto.Capability.CAPABILITY_FETCH_EXPANSIONS);
    if (refused) {
      return refused;
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
      this.refused<proto.ListLanguagesResponse>(proto.Capability.CAPABILITY_LIST_LANGUAGES) ??
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

  private get capabilities(): readonly proto.Capability[] {
    return this.fixtures.capabilities ?? OPERATIONS;
  }

  private failed<T>(): Observable<T> | undefined {
    return this.failure ? throwError(() => this.failure as Error) : undefined;
  }

  /** The injected failure, or UNIMPLEMENTED when `operation` isn't declared. */
  private refused<T>(operation: proto.Capability): Observable<T> | undefined {
    if (this.failure || this.capabilities.includes(operation)) {
      return this.failed<T>();
    }

    return throwError(() =>
      Object.assign(new Error(`${operation} is not declared by this driver`), { code: UNIMPLEMENTED }),
    );
  }
}
