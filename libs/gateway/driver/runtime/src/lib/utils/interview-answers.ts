import {
  ContentFormat,
  ContentType,
  DataGatewayCapability,
  LanguageCodeFormat,
  PlatformType,
  SearchFilterAxis,
  Upstream,
} from '@bge/database';
import type { DescribeResponse, GatewayPingResponse } from '@boardgamesempire/proto-gateway';
import {
  toStoredCapability,
  toStoredContentFormat,
  toStoredContentType,
  toStoredLanguageCodeFormat,
  toStoredPlatformType,
  toStoredSearchFilterAxis,
  toStoredUpstream,
} from './stored-enums';

/** What an interview stores on the DataGateway's row, from its Ping and its Describe. */
export interface InterviewAnswers {
  capabilities: DataGatewayCapability[];
  coveragePlatformTypes: PlatformType[];
  coverageContentTypes: ContentType[];
  filterableAxes: SearchFilterAxis[];
  acceptedLanguageCodeFormats: LanguageCodeFormat[];
  responseLanguageCodeFormat: LanguageCodeFormat | null;
  passthroughSearchLanguage: boolean | null;
  contentFormat: ContentFormat | null;
  gatewayVersion: string | null;
  upstream: Upstream | null;
  fetchGamesMaxIds: number | null;
}

const isStored = <T>(value: T | undefined): value is T => value !== undefined;

/** Each value with a stored equivalent, once, in the order the DataGateway sent them. */
function translate<T>(values: readonly unknown[] | undefined, toStored: (value: unknown) => T | undefined): T[] {
  return [...new Set((values ?? []).map(toStored).filter(isStored))];
}

/**
 * Each value with a stored equivalent, once, in the stored enum's order. Two
 * interviews with the same answers then store identical lists, which is what
 * lets the capabilities write be conditional on the list it replaces.
 */
function translateInEnumOrder<T extends string>(
  values: readonly unknown[] | undefined,
  toStored: (value: unknown) => T | undefined,
  storedEnum: Readonly<Record<string, T>>,
): T[] {
  const order: readonly T[] = Object.values(storedEnum);
  return translate(values, toStored).sort((left, right) => order.indexOf(left) - order.indexOf(right));
}

/**
 * The FetchGames batch limit a DataGateway declared, when it is one a call can
 * be sized by: an integer of at least 1. Without one the interview doesn't
 * store FetchGames, and nothing routes to it (#925).
 */
export function usableFetchGamesMaxIds(limit: number | undefined): number | undefined {
  return limit !== undefined && Number.isInteger(limit) && limit >= 1 ? limit : undefined;
}

/**
 * A DataGateway's answers in the server's terms. Over gRPC an unset field
 * arrives missing, and it's stored unset, as null or an empty list, rather
 * than guessed. A value with no stored equivalent is left out (see
 * `stored-enums`).
 */
export function toInterviewAnswers(description: DescribeResponse, ping: GatewayPingResponse): InterviewAnswers {
  const formats = description.languageCodeFormats;
  const declared = translateInEnumOrder(description.capabilities, toStoredCapability, DataGatewayCapability);

  // A limit without FetchGames means nothing (#925).
  const fetchGamesMaxIds = declared.includes(DataGatewayCapability.FetchGames)
    ? (usableFetchGamesMaxIds(description.fetchGamesMaxIds) ?? null)
    : null;
  const capabilities =
    fetchGamesMaxIds === null
      ? declared.filter((capability) => capability !== DataGatewayCapability.FetchGames)
      : declared;

  return {
    capabilities,
    coveragePlatformTypes: translateInEnumOrder(
      description.coverage?.platformTypes,
      toStoredPlatformType,
      PlatformType,
    ),
    coverageContentTypes: translateInEnumOrder(description.coverage?.contentTypes, toStoredContentType, ContentType),
    filterableAxes: translateInEnumOrder(description.filterableAxes, toStoredSearchFilterAxis, SearchFilterAxis),
    // Most preferred first: the server will translate a search language into
    // the first of these it can produce.
    acceptedLanguageCodeFormats: translate(formats?.acceptedRequestFormats, toStoredLanguageCodeFormat),
    responseLanguageCodeFormat: toStoredLanguageCodeFormat(formats?.responseFormat) ?? null,
    // A false bool never reaches the wire, so it's false whenever the formats
    // were sent at all.
    passthroughSearchLanguage: formats ? formats.passthroughSearchLanguage === true : null,
    contentFormat: toStoredContentFormat(description.contentFormat) ?? null,
    gatewayVersion: ping.gatewayVersion?.trim() || null,
    // One this server doesn't know, from a newer DataGateway, is none (#925).
    upstream: toStoredUpstream(description.upstream) ?? null,
    fetchGamesMaxIds,
  };
}
