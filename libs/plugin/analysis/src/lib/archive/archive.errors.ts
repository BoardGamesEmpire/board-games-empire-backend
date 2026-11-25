import type { PluginArchiveRule } from '@boardgamesempire/plugin-manifest';
import { quoteUntrustedText } from '../untrusted-text.js';

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
        : `The plugin artifact breaks the archive rule '${rule}' at ${quoteUntrustedText(entry)}.`,
    );
  }
}
