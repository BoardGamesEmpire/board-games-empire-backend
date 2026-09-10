import { Readable } from 'node:stream';
import { CacheFlushError } from './ports';
import { RedisKeyFlush } from './redis-key-flush';

// What the flush does with a client: one SCAN per pattern, an UNLINK per batch
// the scan yields, none for a pattern that matches nothing; what it says when
// it cannot finish; and how it hands the connection back. That the keys really
// go from a Valkey is apps/api-e2e/src/bootstrap/cache-flush.spec.ts.

function fakeClient(batches: Record<string, string[][] | Error>, status = 'ready') {
  const scans: { match: string; count?: number }[] = [];
  const unlinked: string[][] = [];
  const closed: string[] = [];
  return {
    scans,
    unlinked,
    closed,
    status,
    scanStream(options: { match: string; count?: number }): AsyncIterable<string[]> {
      scans.push(options);
      const pages = batches[options.match] ?? [];
      if (pages instanceof Error) {
        // A scan whose connection drops: the stream fails before its first page.
        const failing = pages;
        return new Readable({
          objectMode: true,
          read() {
            this.destroy(failing);
          },
        });
      }
      return Readable.from(pages);
    },
    async unlink(...keys: string[]): Promise<number> {
      unlinked.push(keys);
      return keys.length;
    },
    async quit(): Promise<'OK'> {
      closed.push('quit');
      return 'OK';
    },
    disconnect(): void {
      closed.push('disconnect');
    },
  };
}

const USERS = 'api:cache:bge:user:permissions:*';
const KEYS = 'api:cache:bge:apikey:scopes:*';

describe('RedisKeyFlush', () => {
  it('scans each pattern in turn and unlinks every batch the scan yields, reporting how many keys went', async () => {
    const client = fakeClient({
      [USERS]: [
        ['api:cache:bge:user:permissions:u1', 'api:cache:bge:user:permissions:u2'],
        ['api:cache:bge:user:permissions:u3'],
      ],
      [KEYS]: [['api:cache:bge:apikey:scopes:k1']],
    });

    await expect(new RedisKeyFlush(client, [USERS, KEYS]).flush()).resolves.toBe(4);

    expect(client.scans.map((scan) => scan.match)).toEqual([USERS, KEYS]);
    expect(client.unlinked).toEqual([
      ['api:cache:bge:user:permissions:u1', 'api:cache:bge:user:permissions:u2'],
      ['api:cache:bge:user:permissions:u3'],
      ['api:cache:bge:apikey:scopes:k1'],
    ]);
  });

  it('sends no UNLINK for a pattern that yields only empty pages, and reports zero', async () => {
    const client = fakeClient({ [USERS]: [[], []] });

    await expect(new RedisKeyFlush(client, [USERS]).flush()).resolves.toBe(0);

    expect(client.unlinked).toEqual([]);
  });

  it('fails naming the pattern it stopped on and how many keys had already gone, so the log can say which half is still there', async () => {
    const client = fakeClient({
      [USERS]: [
        ['api:cache:bge:user:permissions:u1', 'api:cache:bge:user:permissions:u2', 'api:cache:bge:user:permissions:u3'],
      ],
      [KEYS]: new Error('Connection is closed.'),
    });

    const flush = new RedisKeyFlush(client, [USERS, KEYS]).flush();

    await expect(flush).rejects.toBeInstanceOf(CacheFlushError);
    await expect(flush).rejects.toMatchObject({ pattern: KEYS, removed: 3 });
    await expect(flush).rejects.toThrow(/after removing 3 key\(s\): Connection is closed\./);
  });

  it('close() drops a client that never connected without a round trip, and quits one that did', async () => {
    const lazy = fakeClient({}, 'wait');
    await new RedisKeyFlush(lazy, [USERS]).close();
    expect(lazy.closed).toEqual(['disconnect']);

    const used = fakeClient({}, 'ready');
    await new RedisKeyFlush(used, [USERS]).close();
    expect(used.closed).toEqual(['quit']);
  });
});
