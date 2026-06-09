import type { CorrelationHeaders } from '@bge/shared';
import * as crypto from 'node:crypto';
import { firstValue } from './utils.js';

/**
 * W3C traceparent format: `version-trace_id-parent_id-trace_flags`
 *   version    : 2 hex chars
 *   trace_id   : 32 hex chars (16 bytes)
 *   parent_id  : 16 hex chars (8 bytes)
 *   trace_flags: 2 hex chars
 *
 * trace_id of all zeros is invalid per the spec.
 */
const TRACEPARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const INVALID_TRACE_ID = '0'.repeat(32);

/**
 * Resolves a correlation id from inbound headers, with this priority:
 *   1. W3C `traceparent` header (extracts `trace_id`)
 *   2. `x-correlation-id` header (used verbatim)
 *   3. Generated UUID v4
 *
 * Array-valued headers (Node's HTTP type allows this) take the first entry.
 */
export function resolveCorrelationId(headers: CorrelationHeaders): string {
  const traceId = parseTraceparent(firstValue(headers.traceparent));
  if (traceId) {
    return traceId;
  }

  const provided = firstValue(headers.correlationId)?.trim();
  if (provided) {
    return provided;
  }

  return crypto.randomUUID();
}

/**
 * Returns the `trace_id` component of a W3C traceparent, or `null` if the
 * header is missing/malformed/all-zero.
 */
export function parseTraceparent(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const match = TRACEPARENT_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }

  const traceId = match[2];
  if (traceId === INVALID_TRACE_ID) {
    return null;
  }

  return traceId;
}
