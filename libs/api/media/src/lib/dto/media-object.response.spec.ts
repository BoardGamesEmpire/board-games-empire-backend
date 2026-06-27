import type { MediaObject } from '@bge/database';
import { toMediaObjectResponse } from './media-object.response';

describe('toMediaObjectResponse', () => {
  const row = {
    id: 'm1',
    ownerId: 'u1',
    uploaderId: 'u1',
    visibility: 'Private',
    mimeType: 'image/png',
    sizeBytes: 1234n,
    checksum: 'abc',
    etag: 'abc',
    originalName: 'cat.png',
    driverSlug: 'localdisk',
    driverKey: 'users/u1/m1',
    pageCount: 1,
    width: 800,
    height: 600,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } satisfies MediaObject;

  it('stringifies the BigInt size, emits ISO date strings, and omits the internal storage location', () => {
    const res = toMediaObjectResponse(row);
    expect(res.sizeBytes).toBe('1234');
    expect(typeof res.sizeBytes).toBe('string');
    expect(res.createdAt).toBe('1970-01-01T00:00:00.000Z');
    expect(res.updatedAt).toBe('1970-01-01T00:00:00.000Z');
    expect(typeof res.createdAt).toBe('string');
    expect(res).not.toHaveProperty('driverKey');
    expect(res).not.toHaveProperty('driverSlug');
    expect(() => JSON.stringify(res)).not.toThrow();
  });
});
