import { PlatformType, ReleaseRegion, ReleaseStatus } from '@bge/database';
import type { LocalizationData } from '@board-games-empire/proto-gateway';
import * as proto from '@board-games-empire/proto-gateway';

const PROTO_TO_DB_PLATFORM_TYPE: Record<string, PlatformType> = {
  [proto.PlatformType.PLATFORM_TYPE_CONSOLE]: PlatformType.Console,
  [proto.PlatformType.PLATFORM_TYPE_PC]: PlatformType.PC,
  [proto.PlatformType.PLATFORM_TYPE_PORTABLE]: PlatformType.Console,
  [proto.PlatformType.PLATFORM_TYPE_MOBILE]: PlatformType.Mobile,
  [proto.PlatformType.PLATFORM_TYPE_ARCADE]: PlatformType.Other,
  [proto.PlatformType.PLATFORM_TYPE_TABLETOP]: PlatformType.Tabletop,
  [proto.PlatformType.PLATFORM_TYPE_OTHER]: PlatformType.Other,
};

export function toPlatformType(proto: string | undefined): PlatformType {
  return (proto && PROTO_TO_DB_PLATFORM_TYPE[proto]) || PlatformType.Other;
}

/**
 * Derives the canonical ReleaseRegion from the localizations list.
 * Prefers Worldwide; falls back to the first listed region; defaults to
 * Worldwide when no localization data is present.
 */
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
