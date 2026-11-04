/** A JSON object: not an array, and not `null`. */
export type JsonObject = Readonly<Record<string, unknown>>;

/** Whether `value` is an object, as JSON reads one: not an array, and not `null`. */
export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `text` parsed as JSON when it holds an object, or `null` (#1019). The one
 * reading of a stored record and of a token request's body, so the two can't
 * come to disagree about what an object is.
 */
export function parseJsonObject(text: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
