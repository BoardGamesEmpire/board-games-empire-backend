import { ContentType, PlatformType } from '@bge/database';
import * as proto from '@boardgamesempire/proto-gateway';
import { toCoverageFilter } from './coverage-filter';

describe('toCoverageFilter', () => {
  it('names no axis for a search without a filter, or with empty lists', () => {
    expect(toCoverageFilter(undefined)).toEqual({});
    expect(toCoverageFilter({ platformTypes: [], contentTypes: [] })).toEqual({});
  });

  it('names each axis whose list holds a value, in the server’s terms', () => {
    expect(
      toCoverageFilter({
        platformTypes: [proto.PlatformType.PLATFORM_TYPE_PORTABLE, proto.PlatformType.PLATFORM_TYPE_TABLETOP],
        contentTypes: [proto.ContentType.CONTENT_TYPE_EXPANSION],
      }),
    ).toEqual({
      platformTypes: new Set([PlatformType.Portable, PlatformType.Tabletop]),
      contentTypes: new Set([ContentType.Expansion]),
    });
  });

  it('still names an axis whose values have no stored equivalent, so that it matches nothing', () => {
    expect(
      toCoverageFilter({
        platformTypes: [],
        contentTypes: [proto.ContentType.CONTENT_TYPE_UNSPECIFIED, 42 as unknown as proto.ContentType],
      }),
    ).toEqual({ contentTypes: new Set() });
  });
});
