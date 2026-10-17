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

  /** The coverage describe declares, none unless set. */
  coverage?: proto.Coverage;

  /**
   * The coverage axes describe declares its search narrows by, none unless
   * set. searchGames narrows by a request's filter on these alone.
   */
  filterableAxes?: proto.CoverageAxis[];

  /** fetchGame resolves against these by `externalId`. */
  games?: proto.GameData[];

  /**
   * searchGames streams these (as RESULT frames) for ANY query, then
   * SOURCE_DONE, leaving out those its filter excludes on an axis it
   * declares.
   */
  searchResults?: proto.GameSearchData[];

  /** fetchExpansions streams these per base externalId, then completes. */
  expansionsByBaseExternalId?: Record<string, proto.GameSearchData[]>;

  /** listLanguages returns these. */
  languages?: proto.GatewayLanguageEntry[];
}

/** gRPC's status code for an operation a DataGateway doesn't implement. */
const UNIMPLEMENTED = 12;

/**
 * Whether a list in a search's filter lets a game through: it names nothing,
 * or it names one of the game's values. A game's unspecified value matches
 * no list, even one that names it.
 */
const listMatches = <T>(named: readonly T[] | undefined, values: readonly T[], unspecified: T): boolean =>
  !named?.length || values.some((value) => value !== unspecified && named.includes(value));

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

  /** Declares its fixtures' capabilities, coverage and filterable axes, BCP 47 language codes and plain text. */
  describe(request: proto.DescribeRequest): Observable<proto.DescribeResponse> {
    return (
      this.failed<proto.DescribeResponse>() ??
      of<proto.DescribeResponse>({
        correlationId: request.correlationId ?? 'in-memory',
        capabilities: [...this.capabilities],
        coverage: this.fixtures.coverage ?? { platformTypes: [], contentTypes: [] },
        filterableAxes: [...this.filterableAxes],
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

    const results = (this.fixtures.searchResults ?? [])
      .filter((game) => this.matchesFilter(game, request.filter))
      .map(
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

  private get filterableAxes(): readonly proto.CoverageAxis[] {
    return this.fixtures.filterableAxes ?? [];
  }

  /** Whether a game matches a filter, judged on the axes this driver declares alone. */
  private matchesFilter(game: proto.GameSearchData, filter: proto.SearchFilter | undefined): boolean {
    const declares = (axis: proto.CoverageAxis): boolean => this.filterableAxes.includes(axis);

    return (
      (!declares(proto.CoverageAxis.COVERAGE_AXIS_CONTENT_TYPE) ||
        listMatches(filter?.contentTypes, [game.contentType], proto.ContentType.CONTENT_TYPE_UNSPECIFIED)) &&
      (!declares(proto.CoverageAxis.COVERAGE_AXIS_PLATFORM_TYPE) ||
        listMatches(
          filter?.platformTypes,
          (game.availablePlatforms ?? []).map((platform) => platform.platformType),
          proto.PlatformType.PLATFORM_TYPE_UNSPECIFIED,
        ))
    );
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
