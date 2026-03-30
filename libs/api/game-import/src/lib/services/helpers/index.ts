import { PlatformType, ReleaseRegion } from '@bge/database';
import type { LocalizationData } from '@board-games-empire/proto-gateway';
import { PlatformType as ProtoPlatformType } from '@board-games-empire/proto-gateway';

const PROTO_TO_DB_PLATFORM_TYPE: Record<string, PlatformType> = {
  [ProtoPlatformType.PLATFORM_TYPE_CONSOLE]: PlatformType.Console,
  [ProtoPlatformType.PLATFORM_TYPE_PC]: PlatformType.PC,
  [ProtoPlatformType.PLATFORM_TYPE_PORTABLE]: PlatformType.Console,
  [ProtoPlatformType.PLATFORM_TYPE_MOBILE]: PlatformType.Mobile,
  [ProtoPlatformType.PLATFORM_TYPE_ARCADE]: PlatformType.Other,
  [ProtoPlatformType.PLATFORM_TYPE_TABLETOP]: PlatformType.Tabletop,
  [ProtoPlatformType.PLATFORM_TYPE_OTHER]: PlatformType.Other,
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
