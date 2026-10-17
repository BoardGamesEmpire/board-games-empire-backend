import { CoverageAxis } from '@bge/database';
import { type CoverageFilter, toStoredContentType, toStoredPlatformType } from '@bge/gateway-registry';
import type * as proto from '@boardgamesempire/proto-gateway';

/** A list's values, each once, in one order, so that a search reads the same however they were listed. */
const normalized = <T extends string>(values: readonly T[] | undefined): T[] => [...new Set(values ?? [])].sort();

/**
 * The part of a search's filter a DataGateway is sent: the axes its search
 * narrows by, and no others (#713). Undefined when that leaves nothing to
 * narrow by.
 */
export function filterFor(
  filter: proto.SearchFilter | undefined,
  filterableAxes: readonly CoverageAxis[],
): proto.SearchFilter | undefined {
  const platformTypes = filterableAxes.includes(CoverageAxis.PlatformType) ? normalized(filter?.platformTypes) : [];
  const contentTypes = filterableAxes.includes(CoverageAxis.ContentType) ? normalized(filter?.contentTypes) : [];

  return platformTypes.length > 0 || contentTypes.length > 0 ? { platformTypes, contentTypes } : undefined;
}

/**
 * Whether a DataGateway's result matches a search's filter, as the server
 * judges it whatever the DataGateway narrowed (#713): by its content type,
 * and by the platform types of its available platforms. A value with no
 * stored equivalent never matches, so a game whose content type is
 * unspecified matches no content types, and one without platforms matches
 * no platform types.
 */
export function matchesFilter(game: proto.GameSearchData, filter: CoverageFilter): boolean {
  const { platformTypes, contentTypes } = filter;

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

  return true;
}
