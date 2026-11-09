import type { PluginArchiveRule } from '@boardgamesempire/plugin-manifest';

/** The name is raw archive text: quote it and cut it so it cannot forge lines. */
const printable = (entry: string): string => {
  const quoted = JSON.stringify(entry);
  return quoted.length > 200 ? `${quoted.slice(0, 200)}...` : quoted;
};

/**
 * A plugin artifact archive broke one of the archive rules (#1094). `name` is
 * the stable code a client can match on; the message is plain English.
 */
export class PluginArchiveRefusedError extends Error {
  override readonly name = 'PluginArchiveRefusedError';

  constructor(
    readonly rule: PluginArchiveRule,
    readonly entry?: string,
  ) {
    super(
      entry === undefined
        ? `The plugin artifact breaks the archive rule '${rule}'.`
        : `The plugin artifact breaks the archive rule '${rule}' at ${printable(entry)}.`,
    );
  }
}
