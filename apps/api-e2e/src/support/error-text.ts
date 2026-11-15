/**
 * Every string an error carries, own properties included (`message`,
 * `cause`, Prisma's `meta`), so an assertion on a constraint's name doesn't
 * depend on which layer the driver adapter put Postgres's words in.
 */
export function errorText(value: unknown, depth = 0): string {
  if (depth > 4 || value === null || value === undefined) {
    return '';
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  return Object.getOwnPropertyNames(value)
    .map((key) => errorText((value as Record<string, unknown>)[key], depth + 1))
    .join(' ');
}
