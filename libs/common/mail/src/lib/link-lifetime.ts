/**
 * `Intl.DurationFormat` is in Node 24 but not yet in TypeScript 5.9's lib, so
 * this declares the part of it used here.
 */
interface DurationFormatter {
  format(duration: { hours?: number; minutes?: number }): string;
}

declare global {
  // Merging into the global `Intl` namespace is the only way to type it (#654).
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Intl {
    const DurationFormat: new (locale: string, options: { style: 'long' }) => DurationFormatter;
  }
}

export {};

/**
 * Writes a reset link's lifetime for a person to read, in hours and minutes
 * only. Days would read well in English, but mixing units makes the string
 * harder to localize (#654).
 */
export function formatLinkLifetime(minutes: number, lang: string): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  return new Intl.DurationFormat(lang, { style: 'long' }).format({
    ...(hours > 0 ? { hours } : {}),
    ...(rest > 0 || hours === 0 ? { minutes: rest } : {}),
  });
}
