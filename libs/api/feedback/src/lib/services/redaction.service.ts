import { Injectable } from '@nestjs/common';

/**
 * Server-side redaction.
 *
 * Two-mode scrub:
 *  1. **Content-pattern** redaction over free-form strings (the user's `message`
 *     and any string leaves inside `deviceInfo`). Replaces matched substrings
 *     with `[REDACTED:<kind>]` markers.
 *  2. **Known-key** redaction inside `deviceInfo` — never trust client-supplied
 *     keys like `authToken`, `password`, etc.
 *
 * Decision log: `fast-redact` was evaluated and rejected — it's path-based only
 * (compiles a mutator for known JSON paths) and has no content-pattern facility,
 * which is the larger half of our requirement. A bespoke pass keeps both modes
 * in one place at ~40 LOC and avoids a dep that only partially fits.
 */

interface ContentPattern {
  readonly kind: string;
  readonly pattern: RegExp;
}

const CONTENT_PATTERNS: readonly ContentPattern[] = [
  // RFC-5322-ish email. Conservative; intentionally matches common shapes only.
  { kind: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  // Bearer tokens in headers or pasted log lines.
  { kind: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi },
  // Long opaque hex blobs (≥32 chars) — session ids, hash digests.
  { kind: 'hex', pattern: /\b[a-f0-9]{32,}\b/gi },
  // JWT-shaped tokens.
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g },
];

const KNOWN_SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authtoken',
  'auth_token',
  'sessionid',
  'session_id',
  'cookie',
  'authorization',
]);

export interface RedactionResult<T> {
  readonly value: T;
  readonly mutated: boolean;
}

@Injectable()
export class RedactionService {
  /**
   * Scrub a free-form string in place. Returns the scrubbed string plus a flag
   * indicating whether any substitution occurred.
   */
  scrubString(input: string): RedactionResult<string> {
    let output = input;
    let mutated = false;

    for (const { kind, pattern } of CONTENT_PATTERNS) {
      output = output.replace(pattern, () => {
        mutated = true;

        return `[REDACTED:${kind}]`;
      });
    }

    return { value: output, mutated };
  }

  /**
   * Scrub a deviceInfo-shaped object. Recursively walks keys, replacing values
   * whose key matches a known sensitive name and scrubbing string leaves
   * for content patterns.
   */
  scrubObject(input: Record<string, unknown> | null | undefined): RedactionResult<Record<string, unknown> | null> {
    if (input === null || input === undefined) {
      return { value: null, mutated: false };
    }

    let mutated = false;
    const walk = (node: unknown): unknown => {
      if (typeof node === 'string') {
        const result = this.scrubString(node);

        if (result.mutated) {
          mutated = true;
        }

        return result.value;
      }

      if (Array.isArray(node)) {
        return node.map(walk);
      }

      if (node !== null && typeof node === 'object') {
        const out: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(node)) {
          if (KNOWN_SENSITIVE_KEYS.has(key.toLowerCase())) {
            out[key] = '[REDACTED:key]';
            mutated = true;
            continue;
          }

          out[key] = walk(value);
        }

        return out;
      }

      return node;
    };

    const value = walk(input) as Record<string, unknown>;

    return { value, mutated };
  }
}
