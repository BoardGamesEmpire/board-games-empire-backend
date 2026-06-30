import { SignatureExpiredError, SignatureInvalidError } from '@boardgamesempire/storage-contract';
import { MediaUrlSigner, type SignaturePayload } from './media-url-signer.js';
import type { SigningKeyService } from './signing-key.service.js';

describe('MediaUrlSigner', () => {
  const keys = { getSecret: jest.fn().mockResolvedValue('unit-test-secret') } as unknown as SigningKeyService;
  const signer = new MediaUrlSigner(keys);

  const future = Math.floor(Date.now() / 1000) + 300;
  const base: SignaturePayload = {
    slug: 'localdisk',
    key: 'media/a',
    op: 'get',
    expiresAt: future,
    contentType: 'image/png',
    bindings: { ownerId: 'u1' },
  };

  it('produces a stable hex signature for identical payloads', async () => {
    const a = await signer.sign(base);
    const b = await signer.sign({ ...base });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies a valid signature', async () => {
    await expect(signer.verify(base, await signer.sign(base))).resolves.toBeUndefined();
  });

  it('rejects a signature bound to a different key (confused-deputy)', async () => {
    const sig = await signer.sign(base);
    await expect(signer.verify({ ...base, key: 'media/other' }, sig)).rejects.toBeInstanceOf(SignatureInvalidError);
  });

  it('rejects a signature bound to a different owner', async () => {
    const sig = await signer.sign(base);
    await expect(signer.verify({ ...base, bindings: { ownerId: 'attacker' } }, sig)).rejects.toBeInstanceOf(
      SignatureInvalidError,
    );
  });

  it('rejects a signature bound to a different driver slug (cross-backend replay)', async () => {
    const sig = await signer.sign(base);
    await expect(signer.verify({ ...base, slug: 's3' }, sig)).rejects.toBeInstanceOf(SignatureInvalidError);
  });

  it('rejects a tampered content type', async () => {
    const sig = await signer.sign(base);
    await expect(signer.verify({ ...base, contentType: 'text/html' }, sig)).rejects.toBeInstanceOf(
      SignatureInvalidError,
    );
  });

  it('rejects an expired but validly-signed URL', async () => {
    const expired: SignaturePayload = { ...base, expiresAt: Math.floor(Date.now() / 1000) - 1 };
    await expect(signer.verify(expired, await signer.sign(expired))).rejects.toBeInstanceOf(SignatureExpiredError);
  });

  it('rejects garbage signatures', async () => {
    await expect(signer.verify(base, 'not-hex')).rejects.toBeInstanceOf(SignatureInvalidError);
  });

  it('does not let delimiter characters in bindings cause a signature collision', async () => {
    const a = await signer.sign({ ...base, bindings: { a: 'b', c: 'd' } });
    const b = await signer.sign({ ...base, bindings: { a: 'b&c=d' } });
    expect(a).not.toBe(b); // old `a=b&c=d` joining collided here
  });
});
