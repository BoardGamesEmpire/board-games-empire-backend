import { IS_PUBLIC_KEY } from '@bge/shared';
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import assert from 'node:assert';
import { CHECK_POLICIES_KEY } from '../decorators';
import type { AppAbility, PolicyHandler } from '../interfaces';

@Injectable()
export class PoliciesGuard implements CanActivate {
  constructor(private reflector: Reflector, private cls: ClsService) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const policyHandlers = this.reflector.get<PolicyHandler[]>(CHECK_POLICIES_KEY, context.getHandler()) || [];
    if (policyHandlers.length === 0) {
      // If no policies are defined, allow access by default? Is this handled by isPublic?
      return true;
    }

    const userAbility = this.cls.get<AppAbility>('userAbility');
    assert(userAbility, new ForbiddenException('User ability not found in context.'));

    const userPasses = policyHandlers.every((handler) => this.execPolicyHandler(handler, userAbility));
    assert(userPasses, new ForbiddenException('You do not have permission to perform this action.'));

    const apiKeyAbility = this.cls.get<AppAbility>('apiKeyAbility');
    if (apiKeyAbility) {
      const keyPasses = policyHandlers.every((handler) => this.execPolicyHandler(handler, apiKeyAbility));
      assert(keyPasses, new ForbiddenException('This API Key does not have the required permissions for this action.'));
    }

    return true;
  }

  private execPolicyHandler(handler: PolicyHandler, ability: AppAbility) {
    if (typeof handler === 'function') {
      return handler(ability);
    }
    return handler.handle(ability);
  }
}
