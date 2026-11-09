import { Buffer } from 'node:buffer';
import { gzipSync } from 'node:zlib';
import { pack } from 'tar-stream';

export interface PluginTarballEntry {
  readonly name: string;
  readonly type?: 'file' | 'directory' | 'symlink' | 'link';
  readonly content?: string;
  readonly linkname?: string;
  /** Pax extended-header records, which override the header's own fields. */
  readonly pax?: Record<string, string>;
}

/**
 * For tests (#1094): a gzip-compressed tar of `entries`, built with
 * `tar-stream` so a spec can write the entries a hostile archive would hold
 * (links, `../` paths, pax overrides) that a normal packer refuses to emit.
 */
export const buildPluginTarball = async (entries: ReadonlyArray<PluginTarballEntry>): Promise<Buffer> => {
  const archive = pack();
  const chunks: Buffer[] = [];
  const collected = (async () => {
    for await (const chunk of archive) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
  })();

  for (const entry of entries) {
    const type = entry.type ?? 'file';
    const body = type === 'file' ? Buffer.from(entry.content ?? '') : undefined;

    await new Promise<void>((resolve, reject) => {
      const header = {
        name: entry.name,
        type,
        ...(entry.linkname === undefined ? {} : { linkname: entry.linkname }),
        ...(entry.pax === undefined ? {} : { pax: entry.pax }),
        ...(body === undefined ? {} : { size: body.length }),
      };
      const callback = (err?: Error | null) => (err ? reject(err) : resolve());

      if (body === undefined) {
        archive.entry(header, callback);
      } else {
        archive.entry(header, body, callback);
      }
    });
  }

  archive.finalize();
  await collected;

  return gzipSync(Buffer.concat(chunks));
};
