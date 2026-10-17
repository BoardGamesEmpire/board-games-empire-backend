import type { ContentType, PlatformType } from '@bge/database';
import type * as proto from '@boardgamesempire/proto-gateway';
import { toStoredContentType, toStoredPlatformType } from './stored-enums';

/**
 * A search's filter in the server's terms. An axis is present when the filter
 * names a value on it. A value with no stored equivalent matches nothing, so
 * it's left out of its set but still names its axis: a filter naming only such
 * values matches nothing on that axis, rather than not narrowing it.
 */
export interface CoverageFilter {
  readonly platformTypes?: ReadonlySet<PlatformType>;
  readonly contentTypes?: ReadonlySet<ContentType>;
}

/** The values a list names, in the server's terms, or undefined when it names none. */
const storedSet = <T>(
  values: readonly unknown[] | undefined,
  toStored: (value: unknown) => T | undefined,
): ReadonlySet<T> | undefined =>
  values?.length ? new Set(values.flatMap((value) => toStored(value) ?? [])) : undefined;

/** A search request's filter in the server's terms. */
export function toCoverageFilter(filter: proto.SearchFilter | undefined): CoverageFilter {
  const platformTypes = storedSet(filter?.platformTypes, toStoredPlatformType);
  const contentTypes = storedSet(filter?.contentTypes, toStoredContentType);

  return { ...(platformTypes && { platformTypes }), ...(contentTypes && { contentTypes }) };
}
