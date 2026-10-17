import { PlatformType, ReleaseRegion, ReleaseStatus } from '@bge/database';
import { toStoredPlatformType } from '@bge/gateway-registry';
import type { LocalizationData } from '@boardgamesempire/proto-gateway';
import * as proto from '@boardgamesempire/proto-gateway';

/**
 * Folds portable into console and arcade into other, as a DataGateway's
 * coverage is stored, through the same map. A type with no stored
 * equivalent is stored as other.
 */
export function toPlatformType(proto: string | undefined): PlatformType {
  return toStoredPlatformType(proto) ?? PlatformType.Other;
}

/**
 * Sentinel value used as `editionKey` for releases emitted by gateways that
 * don't surface edition data (BGG without versions=1 fallback, IGDB without
 * release-entity granularity). The import worker treats "default" as a
 * synthetic baseline that should never be overwritten by a non-default
 * edition with the same region — see GameRelease unique constraint
 * (platformGameId, editionKey, region).
 */
export const DEFAULT_EDITION_KEY = 'default';

/**
 * Coerces a possibly-empty externalId into a usable editionKey. Falls
 * back to the synthetic default when the gateway emits an empty string —
 * which would otherwise produce an unusable unique-constraint key.
 */
export function toEditionKey(externalId: string | undefined): string {
  return externalId && externalId.toString().trim().length > 0 ? externalId.toString() : DEFAULT_EDITION_KEY;
}

export function toReleaseRegion(localizations: LocalizationData[]): ReleaseRegion {
  if (!localizations.length) return ReleaseRegion.Worldwide;

  const REGION_CODE_MAP: Record<string, ReleaseRegion> = {
    ww: ReleaseRegion.Worldwide,
    us: ReleaseRegion.NorthAmerica,
    eu: ReleaseRegion.Europe,
    jp: ReleaseRegion.Japan,
    au: ReleaseRegion.Australia,
    as: ReleaseRegion.Asia,
    br: ReleaseRegion.Brazil,
    kr: ReleaseRegion.Korea,
  };

  const worldwide = localizations.find((l) => l.region?.regionCode === 'ww');
  const first = worldwide ?? localizations[0];
  return (first.region && REGION_CODE_MAP[first.region.regionCode]) || ReleaseRegion.Worldwide;
}

export function toReleaseDate(iso?: string): Date | undefined {
  return iso ? new Date(iso) : undefined;
}

const PROTO_TO_DB_RELEASE_STATUS: Record<string, ReleaseStatus> = {
  [proto.ReleaseStatus.RELEASE_STATUS_RELEASED]: ReleaseStatus.Released,
  [proto.ReleaseStatus.RELEASE_STATUS_ALPHA]: ReleaseStatus.Alpha,
  [proto.ReleaseStatus.RELEASE_STATUS_BETA]: ReleaseStatus.Beta,
  [proto.ReleaseStatus.RELEASE_STATUS_EARLY_ACCESS]: ReleaseStatus.EarlyAccess,
  [proto.ReleaseStatus.RELEASE_STATUS_OFFLINE]: ReleaseStatus.Offline,
  [proto.ReleaseStatus.RELEASE_STATUS_CANCELLED]: ReleaseStatus.Cancelled,
  [proto.ReleaseStatus.RELEASE_STATUS_RUMOURED]: ReleaseStatus.Rumoured,
  [proto.ReleaseStatus.RELEASE_STATUS_ANNOUNCED]: ReleaseStatus.Announced,
  [proto.ReleaseStatus.RELEASE_STATUS_POSTPONED]: ReleaseStatus.Postponed,
  [proto.ReleaseStatus.RELEASE_STATUS_PRERELEASE]: ReleaseStatus.Prerelease,
  [proto.ReleaseStatus.RELEASE_STATUS_DELISTED]: ReleaseStatus.Delisted,
};

export function toReleaseStatus(proto: string | undefined): ReleaseStatus {
  return (proto && PROTO_TO_DB_RELEASE_STATUS[proto]) || ReleaseStatus.Unspecified;
}
