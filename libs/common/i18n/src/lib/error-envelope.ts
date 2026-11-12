import { STATUS_CODES } from 'node:http';

/**
 * A machine-readable name for one specific refusal, in SCREAMING_SNAKE
 * (`CATALOG_ENTRY_CHANGED`). A client branches on it, or announces its own
 * copy for it, without parsing the message. There is no generic per-status
 * code: an error that names no specific refusal carries none (#1260).
 */
export type ErrorCode = Uppercase<string>;

/**
 * The one shape every HTTP error leaves the api in (#1260):
 *
 * - `statusCode` is the response status;
 * - `error` is that status's standard reason phrase, never a custom label;
 * - `message` is the plain-language copy, or a list of it for a validation 400;
 * - `code` is present exactly when the error names one specific refusal.
 *
 * Any other field (a quota's `limit`, a permission catalog refusal's `problems`) sits
 * beside these.
 */
export interface ErrorEnvelope<M = string | string[]> {
  readonly statusCode: number;
  readonly error: string;
  readonly message: M;
  readonly code?: ErrorCode;
  readonly [field: string]: unknown;
}

/** The keys the envelope owns. No extra field of the same name reaches the wire. */
export const ENVELOPE_FIELDS: ReadonlySet<string> = new Set(['statusCode', 'error', 'message']);

/**
 * Builds the envelope for `status`. `error` is the status's reason phrase, or
 * `'Error'` for a status Node names none for. A field named like an envelope
 * key is dropped rather than allowed to contradict the status (#1260). The
 * message is generic so a coded exception can carry its marker unrendered
 * until the edge.
 */
export function errorEnvelope<M>(
  status: number,
  message: M,
  fields: Readonly<Record<string, unknown>> = {},
): ErrorEnvelope<M> {
  const extra = Object.fromEntries(Object.entries(fields).filter(([key]) => !ENVELOPE_FIELDS.has(key)));
  return { statusCode: status, error: reasonPhrase(status), message, ...extra };
}

/** The standard reason phrase for `status`, or `'Error'` when Node names none. */
export function reasonPhrase(status: number): string {
  return STATUS_CODES[status] ?? 'Error';
}

/**
 * Derives an error code from an error class name, so a family of refusal
 * classes (the plugin errors, the deadlock) needs no hand-kept code table:
 * `PluginGrantScopeIdError` → `PLUGIN_GRANT_SCOPE_ID`. A trailing `Error` is
 * dropped, and an acronym stays one word (`PluginSDKVersionError` →
 * `PLUGIN_SDK_VERSION`) (#1260).
 */
export function toErrorCode(name: string): ErrorCode {
  return name
    .replace(/Error$/, '')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toUpperCase() as ErrorCode;
}
