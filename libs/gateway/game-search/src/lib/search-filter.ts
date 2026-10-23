import { SearchFilterAxis } from '@bge/database';
import {
  type CoverageFilter,
  toCoverageFilter,
  toStoredContentType,
  toStoredPlatformType,
} from '@bge/gateway-registry';
import type * as proto from '@boardgamesempire/proto-gateway';

/**
 * An inclusive range of publish years that narrows by at least one bound
 * (#719). A game with no known year matches it only when `includeUnknown`.
 */
export interface YearRange {
  readonly min?: number;
  readonly max?: number;
  readonly includeUnknown: boolean;
}

/**
 * A search's filter as the server matches results against it: the coverage
 * axes, which also route the search, and the publish year, which only
 * narrows it.
 */
export interface ResultFilter extends CoverageFilter {
  readonly publishYear?: YearRange;
}

/** A list's values, each once, in one order, so that a search reads the same however they were listed. */
const normalized = <T extends string>(values: readonly T[] | undefined): T[] => [...new Set(values ?? [])].sort();

/** A bound as sent, or undefined when it's missing: the gRPC loader can hand over null for an unset field. */
const bound = (value: number | undefined): number | undefined => (typeof value === 'number' ? value : undefined);

/**
 * A range in the server's terms, or undefined when it names no bound: a range
 * with neither narrows nothing, whatever it says of unknown years.
 */
function toYearRange(range: proto.IntRange | undefined): YearRange | undefined {
  const min = bound(range?.min);
  const max = bound(range?.max);

  if (min === undefined && max === undefined) {
    return undefined;
  }

  return {
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    includeUnknown: range?.includeUnknown === true,
  };
}

/** A search request's filter as results are matched against it. */
export function toResultFilter(filter: proto.SearchFilter | undefined): ResultFilter {
  const publishYear = toYearRange(filter?.publishYear);

  return { ...toCoverageFilter(filter), ...(publishYear && { publishYear }) };
}

/**
 * The part of a search's filter a DataGateway is sent: the axes its search
 * narrows by, and no others (#713). Undefined when that leaves nothing to
 * narrow by. A publish year is sent as its bounds, with `includeUnknown`
 * only when set, so a range reads the same however it was written (#719).
 */
export function filterFor(
  filter: proto.SearchFilter | undefined,
  filterableAxes: readonly SearchFilterAxis[],
): proto.SearchFilter | undefined {
  const platformTypes = filterableAxes.includes(SearchFilterAxis.PlatformType) ? normalized(filter?.platformTypes) : [];
  const contentTypes = filterableAxes.includes(SearchFilterAxis.ContentType) ? normalized(filter?.contentTypes) : [];
  const year = filterableAxes.includes(SearchFilterAxis.PublishYear) ? toYearRange(filter?.publishYear) : undefined;

  if (platformTypes.length === 0 && contentTypes.length === 0 && year === undefined) {
    return undefined;
  }

  return {
    platformTypes,
    contentTypes,
    ...(year && {
      publishYear: {
        ...(year.min === undefined ? {} : { min: year.min }),
        ...(year.max === undefined ? {} : { max: year.max }),
        ...(year.includeUnknown ? { includeUnknown: true } : {}),
      },
    }),
  };
}

/** Whether a publish year falls in `range`; only a missing year is unknown. */
const inYearRange = (year: number | undefined, { min, max, includeUnknown }: YearRange): boolean =>
  typeof year === 'number' ? (min === undefined || year >= min) && (max === undefined || year <= max) : includeUnknown;

/**
 * Whether a DataGateway's result matches a search's filter, as the server
 * judges it whatever the DataGateway narrowed (#713): by its content type,
 * by the platform types of its available platforms, and by its publish year
 * (#719). A value with no stored equivalent never matches, so a game whose
 * content type is unspecified matches no content types, and one without
 * platforms matches no platform types. A game with no publish year matches a
 * year range only when the range includes unknown ones.
 */
export function matchesFilter(game: proto.GameSearchData, filter: ResultFilter): boolean {
  const { platformTypes, contentTypes, publishYear } = filter;

  if (contentTypes) {
    const contentType = toStoredContentType(game.contentType);
    if (contentType === undefined || !contentTypes.has(contentType)) {
      return false;
    }
  }

  if (platformTypes) {
    const onNamedPlatform = (game.availablePlatforms ?? []).some((platform) => {
      const platformType = toStoredPlatformType(platform.platformType);
      return platformType !== undefined && platformTypes.has(platformType);
    });

    if (!onNamedPlatform) {
      return false;
    }
  }

  return publishYear === undefined || inYearRange(game.yearPublished, publishYear);
}
