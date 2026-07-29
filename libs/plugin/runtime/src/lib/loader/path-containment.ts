import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

/**
 * Filesystem containment primitives for the loader's trust boundary.
 *
 * Every path the loader touches must provably live under a configured root.
 * Lexical checks (`resolve`/`relative`) are necessary but not sufficient: a
 * symlink anywhere along the path — the plugin directory itself, or a file
 * inside it — resolves to a location the string arithmetic never sees. So
 * containment is always asserted against `realpath` of BOTH sides.
 *
 * Symlinks are not banned outright, only escapes: a link pointing to another
 * location inside the same root is legitimate (build layouts do this), while
 * one pointing out of it is not. That is the same rule the entrypoint check
 * applies, so the whole loader treats links consistently.
 */

/** Resolves a path through symlinks, or `null` when it cannot be resolved (missing, broken link, permission). */
export async function realpathOrNull(path: string): Promise<string | null> {
  return realpath(path).catch(() => null);
}

/**
 * True when `realChild` lies strictly inside `realParent`. Both arguments
 * must already be realpath-resolved — passing lexical paths defeats the
 * purpose. Equality is NOT containment: a path identical to the parent is
 * the parent, never a child within it.
 */
export function isContained(realParent: string, realChild: string): boolean {
  const relativeToParent = relative(realParent, realChild);

  return (
    relativeToParent !== '' &&
    relativeToParent !== '..' &&
    !relativeToParent.startsWith(`..${sep}`) &&
    !isAbsolute(relativeToParent)
  );
}
