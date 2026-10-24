import {
  ContentFormat,
  ContentType,
  DataGatewayCapability,
  LanguageCodeFormat,
  PlatformType,
  SearchFilterAxis,
} from '@bge/database';
import * as proto from '@boardgamesempire/proto-gateway';

/*
 * The proto enum values a DataGateway sends, as the server stores them. Each
 * map is keyed by the proto value's name, which is how it arrives: the
 * generated types are string enums, and the gRPC client loads enums as
 * strings. A value with no entry, such as an UNSPECIFIED one, or one the
 * server's proto doesn't know (gRPC hands those over as bare numbers), has no
 * stored equivalent, and each caller decides what that means.
 */

type ByProtoName<T> = Readonly<Record<string, T>>;

const CAPABILITIES: ByProtoName<DataGatewayCapability> = {
  [proto.Capability.CAPABILITY_SEARCH]: DataGatewayCapability.Search,
  [proto.Capability.CAPABILITY_FETCH]: DataGatewayCapability.Fetch,
  [proto.Capability.CAPABILITY_FETCH_EXPANSIONS]: DataGatewayCapability.FetchExpansions,
  [proto.Capability.CAPABILITY_LIST_LANGUAGES]: DataGatewayCapability.ListLanguages,
  [proto.Capability.CAPABILITY_LIST_PLATFORMS]: DataGatewayCapability.ListPlatforms,
  [proto.Capability.CAPABILITY_LIST_CATEGORIES]: DataGatewayCapability.ListCategories,
  [proto.Capability.CAPABILITY_LIST_MECHANICS]: DataGatewayCapability.ListMechanics,
};

const PLATFORM_TYPES: ByProtoName<PlatformType> = {
  [proto.PlatformType.PLATFORM_TYPE_CONSOLE]: PlatformType.Console,
  [proto.PlatformType.PLATFORM_TYPE_PC]: PlatformType.PC,
  [proto.PlatformType.PLATFORM_TYPE_PORTABLE]: PlatformType.Portable,
  [proto.PlatformType.PLATFORM_TYPE_MOBILE]: PlatformType.Mobile,
  [proto.PlatformType.PLATFORM_TYPE_ARCADE]: PlatformType.Arcade,
  [proto.PlatformType.PLATFORM_TYPE_TABLETOP]: PlatformType.Tabletop,
  [proto.PlatformType.PLATFORM_TYPE_OTHER]: PlatformType.Other,
};

const CONTENT_TYPES: ByProtoName<ContentType> = {
  [proto.ContentType.CONTENT_TYPE_BASE_GAME]: ContentType.BaseGame,
  [proto.ContentType.CONTENT_TYPE_EXPANSION]: ContentType.Expansion,
  [proto.ContentType.CONTENT_TYPE_DLC]: ContentType.DLC,
  [proto.ContentType.CONTENT_TYPE_STANDALONE_EXPANSION]: ContentType.StandaloneExpansion,
  [proto.ContentType.CONTENT_TYPE_ACCESSORY]: ContentType.Accessory,
  [proto.ContentType.CONTENT_TYPE_BUNDLE]: ContentType.Bundle,
  [proto.ContentType.CONTENT_TYPE_REMAKE]: ContentType.Remake,
  [proto.ContentType.CONTENT_TYPE_REMASTER]: ContentType.Remaster,
  [proto.ContentType.CONTENT_TYPE_EXPANDED_EDITION]: ContentType.ExpandedEdition,
  [proto.ContentType.CONTENT_TYPE_PORT]: ContentType.Port,
  [proto.ContentType.CONTENT_TYPE_MOD]: ContentType.Mod,
};

const SEARCH_FILTER_AXES: ByProtoName<SearchFilterAxis> = {
  [proto.SearchFilterAxis.SEARCH_FILTER_AXIS_PLATFORM_TYPE]: SearchFilterAxis.PlatformType,
  [proto.SearchFilterAxis.SEARCH_FILTER_AXIS_CONTENT_TYPE]: SearchFilterAxis.ContentType,
  [proto.SearchFilterAxis.SEARCH_FILTER_AXIS_PUBLISH_YEAR]: SearchFilterAxis.PublishYear,
};

const LANGUAGE_CODE_FORMATS: ByProtoName<LanguageCodeFormat> = {
  [proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_ISO_639_1]: LanguageCodeFormat.Iso6391,
  [proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_ISO_639_3]: LanguageCodeFormat.Iso6393,
  [proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47]: LanguageCodeFormat.IetfBcp47,
  [proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_NAME]: LanguageCodeFormat.Name,
  [proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_NATIVE_NAME]: LanguageCodeFormat.NativeName,
};

const CONTENT_FORMATS: ByProtoName<ContentFormat> = {
  [proto.ContentFormat.CONTENT_FORMAT_PLAIN_TEXT]: ContentFormat.PlainText,
  [proto.ContentFormat.CONTENT_FORMAT_HTML]: ContentFormat.Html,
  [proto.ContentFormat.CONTENT_FORMAT_BBCODE]: ContentFormat.BBCode,
  [proto.ContentFormat.CONTENT_FORMAT_MARKDOWN]: ContentFormat.Markdown,
};

// Own keys only, so a value that happens to name an Object.prototype member
// finds nothing.
const lookup = <T>(byName: ByProtoName<T>, value: unknown): T | undefined =>
  typeof value === 'string' && Object.hasOwn(byName, value) ? byName[value] : undefined;

export const toStoredCapability = (value: unknown): DataGatewayCapability | undefined => lookup(CAPABILITIES, value);

export const toStoredPlatformType = (value: unknown): PlatformType | undefined => lookup(PLATFORM_TYPES, value);

export const toStoredContentType = (value: unknown): ContentType | undefined => lookup(CONTENT_TYPES, value);

export const toStoredSearchFilterAxis = (value: unknown): SearchFilterAxis | undefined =>
  lookup(SEARCH_FILTER_AXES, value);

export const toStoredLanguageCodeFormat = (value: unknown): LanguageCodeFormat | undefined =>
  lookup(LANGUAGE_CODE_FORMATS, value);

export const toStoredContentFormat = (value: unknown): ContentFormat | undefined => lookup(CONTENT_FORMATS, value);

/*
 * The other way: the proto value a stored one is sent as, for a search the
 * server asks in its own terms. Each map above is one to one, so each stored
 * value has one proto name at most. ContentType.Unknown has none.
 */

const byStoredValue = <T extends string, P extends string>(byName: ByProtoName<T>): ReadonlyMap<T, P> =>
  new Map(Object.entries(byName).map(([name, stored]) => [stored, name as P]));

const PROTO_PLATFORM_TYPES = byStoredValue<PlatformType, proto.PlatformType>(PLATFORM_TYPES);

const PROTO_CONTENT_TYPES = byStoredValue<ContentType, proto.ContentType>(CONTENT_TYPES);

export const toProtoPlatformType = (value: PlatformType): proto.PlatformType | undefined =>
  PROTO_PLATFORM_TYPES.get(value);

export const toProtoContentType = (value: ContentType): proto.ContentType | undefined => PROTO_CONTENT_TYPES.get(value);
