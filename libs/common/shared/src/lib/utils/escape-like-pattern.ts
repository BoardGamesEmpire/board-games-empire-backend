/**
 * Prisma hands the string filters that reach SQL `LIKE` (`startsWith`,
 * `contains`, `endsWith`) the value as written, where `%` and `_` are
 * wildcards and a backslash escapes the next character. Escaping all three
 * makes the value match only itself.
 *
 * Two readers depend on that. A sign-in's username variants (#912): unescaped,
 * the prefix `a\b-` would miss `a\b-2`, and every retry would then pick the
 * same taken variant. And the staff households search (#419): unescaped, a
 * search for `100%` would match every name containing `100`, and one for
 * `a_b` would match `aXb`.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
