import { parseCidr } from '@bge/secure-http';
import {
  registerDecorator,
  type ValidationOptions,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { isFQDN } from 'validator';

/**
 * Validates that a string is either:
 *   - A valid hostname (RFC 1123, with or without TLD — internal hostnames
 *     like `jenkins` are permitted because self-hosted admins commonly use
 *     them).
 *   - A wildcard prefix of the form `*.hostname` where the suffix is a
 *     valid hostname.
 *
 * Wildcard *acceptance* here is purely a format check — whether wildcards
 * are *permitted by policy* depends on the effective `strictMode` after
 * the update applies, which the service layer cross-checks. This validator
 * does not see the strict-mode flag, so it doesn't reject wildcards at
 * this level.
 */
@ValidatorConstraint({ name: 'isHostnameOrWildcard', async: false })
export class IsHostnameOrWildcardConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const candidate = value.startsWith('*.') ? value.slice(2) : value;
    if (candidate.length === 0) return false;
    return isFQDN(candidate, { require_tld: false, allow_underscores: false });
  }

  defaultMessage(): string {
    return 'Each entry must be a valid hostname or wildcard (e.g. "example.com" or "*.example.com")';
  }
}

/**
 * Property decorator wrapping `IsHostnameOrWildcardConstraint` for use with
 * `@IsArray()` + `@ValidateEach()` semantics on a `string[]` property.
 */
export function IsHostnameOrWildcardArray(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isHostnameOrWildcardArray',
      target: object.constructor,
      propertyName,
      options: { each: true, ...validationOptions },
      constraints: [],
      validator: IsHostnameOrWildcardConstraint,
    });
  };
}

/**
 * Validates that a string is a parseable CIDR notation entry. Delegates
 * to `parseCidr` from `@bge/secure-http` so the admin DTO and the runtime
 * evaluator agree on what counts as valid — there's no scenario where
 * a write succeeds and the loader silently drops the entry.
 *
 * Bare IPs without `/N` are rejected (matches `parseCidr` semantics). For
 * single-IP entries, admins use the host list or an explicit `/32` / `/128`.
 */
@ValidatorConstraint({ name: 'isCidr', async: false })
export class IsCidrConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    return parseCidr(value) !== null;
  }

  defaultMessage(): string {
    return 'Each entry must be a valid CIDR (e.g. "10.0.0.0/8" or "fc00::/7"). Single IPs require explicit prefix (e.g. "10.0.0.5/32")';
  }
}

export function IsCidrArray(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isCidrArray',
      target: object.constructor,
      propertyName,
      options: { each: true, ...validationOptions },
      constraints: [],
      validator: IsCidrConstraint,
    });
  };
}
