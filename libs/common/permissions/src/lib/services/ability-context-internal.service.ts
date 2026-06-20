import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { AppAbility } from '../interfaces';

/**
 * CLS key for the per-request resolved ability array. Exported for the
 * priming middleware and tests only — application code must never read it
 * directly; it goes through the public `AbilityService`.
 */
export const ABILITIES_CLS_KEY = 'permissions:abilities' as const;

/**
 * Internal writer/reader for the per-request ability array.
 *
 * This is deliberately NOT exported from the lib's public barrel. The only
 * sanctioned writer is `AbilityContextMiddleware` (the entry-point populator);
 * everything else reads abilities through `AbilityService.getCurrentAbilities()`.
 * Keeping the setter off the public surface mirrors the
 * `AuditContextInternalService` pattern and prevents consumers (and, later,
 * plugins) from forging an ability set.
 */
@Injectable()
export class AbilityContextInternalService {
  constructor(private readonly cls: ClsService) {}

  /**
   * Stores the resolved abilities for the current request scope. Priming with
   * an empty array is meaningful: it represents an authenticated-but-no-access
   * actor (or an unauthenticated request) and is treated downstream as a denial,
   * never as an unfiltered query.
   */
  prime(abilities: AppAbility[]): void {
    this.cls.set(ABILITIES_CLS_KEY, abilities);
  }

  /**
   * Returns the primed ability array, or `null` when nothing has been primed
   * (no populator ran for this context). The `null`/`[]` distinction matters:
   * `null` is "context not populated" (programmer error) while `[]` is
   * "populated, no abilities" (a denial).
   */
  peek(): AppAbility[] | null {
    return this.cls.get<AppAbility[] | undefined>(ABILITIES_CLS_KEY) ?? null;
  }
}
