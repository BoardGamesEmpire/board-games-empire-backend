import { IS_PUBLIC_KEY } from '@bge/shared';
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AbilityService } from '../ability.service';
import { CHECK_POLICIES_KEY } from '../decorators';
import type { AppAbility, PolicyHandler } from '../interfaces';

@Injectable()
export class PoliciesGuard implements CanActivate {
  private readonly logger = new Logger(PoliciesGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly abilityService: AbilityService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const policyHandlers = this.reflector.get<PolicyHandler[]>(CHECK_POLICIES_KEY, context.getHandler()) ?? [];
    if (policyHandlers.length === 0) {
      return true;
    }

    // Empty abilities (anonymous or not-yet-supported actor kinds) cannot
    // satisfy any policy: deny rather than vacuously pass `[].every(...)`.
    const abilities = this.abilityService.getCurrentAbilities();
    if (abilities.length === 0) {
      throw new ForbiddenException('You do not have permission to perform this action.');
    }

    // Every ability must satisfy every handler. For an API key actor the array
    // is `[ownerAbility, apiKeyAbility]`, so this reproduces the two-ability
    // intersection at the guard layer (the user AND the key must both pass).
    const passes = abilities.every((ability) => this.satisfiesPolicies(policyHandlers, ability));
    if (!passes) {
      this.logger.debug(
        `Access denied by PoliciesGuard: at least one of ${abilities.length} ability set(s) failed a policy ` +
          `handler (${policyHandlers.length} handler(s) checked).`,
      );

      throw new ForbiddenException('You do not have permission to perform this action.');
    }

    this.logger.debug('Access granted by PoliciesGuard');

    return true;
  }

  private satisfiesPolicies(handlers: PolicyHandler[], ability: AppAbility): boolean {
    return handlers.every((handler) => this.execPolicyHandler(handler, ability));
  }

  private execPolicyHandler(handler: PolicyHandler, ability: AppAbility): boolean {
    if (typeof handler === 'function') {
      return handler(ability);
    }

    return handler.handle(ability);
  }
}
