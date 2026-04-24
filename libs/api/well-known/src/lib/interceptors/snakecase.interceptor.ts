import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Scoped interceptor that serializes response bodies with snake_case keys
 */
@Injectable()
export class SnakeCaseInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map(transformKeysToSnakeCase));
  }
}

/**
 * Converts a camelCase string to snake_case.
 * Handles standard camelCase property names. Property names should avoid
 * consecutive uppercase letters (e.g. use `baseUrl` not `baseURL`).
 */
export function toSnakeCase(str: string): string {
  return str.replace(/([A-Z])/g, '_$1').toLowerCase();
}

/**
 * Recursively transforms all object keys to snake_case.
 * - Plain objects: keys transformed, values recursed into
 * - Arrays: each element recursed into
 * - Primitives / Dates / null: returned as-is
 *
 * Only keys are transformed — string values are never mutated.
 */
export function transformKeysToSnakeCase(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(transformKeysToSnakeCase);
  }

  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        toSnakeCase(key),
        transformKeysToSnakeCase(val),
      ]),
    );
  }

  return value;
}
