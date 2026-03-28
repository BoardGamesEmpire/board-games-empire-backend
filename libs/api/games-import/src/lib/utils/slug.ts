/**
 * Normalizes a display name to a lowercase, hyphenated slug suitable for
 * use as a unique key on Mechanic, Category, and Family records.
 *
 * Steps:
 *  1. NFD decompose → strip combining diacritics (café → cafe)
 *  2. Lowercase
 *  3. Remove anything that isn't alphanumeric or whitespace/hyphen
 *  4. Collapse runs of whitespace to a single hyphen
 *
 * Examples:
 *   "Worker Placement"       → "worker-placement"
 *   "Push Your Luck"         → "push-your-luck"
 *   "Deck, Bag, and Pool Building" → "deck-bag-and-pool-building"
 */
export function toSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-');
}
