import { ContentType, DataGatewayCapability, PlatformType } from '@bge/database';
import * as proto from '@boardgamesempire/proto-gateway';
import {
  toProtoContentType,
  toProtoPlatformType,
  toStoredCapability,
  toStoredContentType,
  toStoredPlatformType,
} from './stored-enums';

describe('stored enums', () => {
  it('sends every stored platform type as a proto value that is stored as it again', () => {
    for (const stored of Object.values(PlatformType)) {
      expect(toStoredPlatformType(toProtoPlatformType(stored))).toBe(stored);
    }
  });

  it('stores every proto platform type but unspecified as a platform type of its own', () => {
    // UNRECOGNIZED is ts-proto's stand-in for a value it doesn't know, never sent.
    const unsent: readonly proto.PlatformType[] = [
      proto.PlatformType.PLATFORM_TYPE_UNSPECIFIED,
      proto.PlatformType.UNRECOGNIZED,
    ];
    const sent = Object.values(proto.PlatformType).filter((type) => !unsent.includes(type));

    const stored = sent.map(toStoredPlatformType);

    expect(stored).not.toContain(undefined);
    expect(new Set(stored).size).toBe(sent.length);
  });

  it('sends every stored content type but unknown as a proto value that is stored as it again', () => {
    for (const stored of Object.values(ContentType).filter((type) => type !== ContentType.Unknown)) {
      expect(toStoredContentType(toProtoContentType(stored))).toBe(stored);
    }
  });

  // The map back to proto values keeps one proto name per stored value, so
  // two names stored alike would leave filters sent as only one of them.
  it('stores every proto content type but unspecified as a content type of its own', () => {
    const unsent: readonly proto.ContentType[] = [
      proto.ContentType.CONTENT_TYPE_UNSPECIFIED,
      proto.ContentType.UNRECOGNIZED,
    ];
    const sent = Object.values(proto.ContentType).filter((type) => !unsent.includes(type));

    const stored = sent.map(toStoredContentType);

    expect(stored).not.toContain(undefined);
    expect(new Set(stored).size).toBe(sent.length);
  });

  it('has no proto value for an unknown content type', () => {
    expect(toProtoContentType(ContentType.Unknown)).toBeUndefined();
  });

  it('stores each list capability (#718)', () => {
    expect(toStoredCapability(proto.Capability.CAPABILITY_LIST_PLATFORMS)).toBe(DataGatewayCapability.ListPlatforms);
    expect(toStoredCapability(proto.Capability.CAPABILITY_LIST_CATEGORIES)).toBe(DataGatewayCapability.ListCategories);
    expect(toStoredCapability(proto.Capability.CAPABILITY_LIST_MECHANICS)).toBe(DataGatewayCapability.ListMechanics);
  });
});
