import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AbilityFactory } from '../ability.factory';
import type { ApikeyWithScopes } from '../interfaces';
import { PermissionsService } from '../permissions.service';

@Injectable()
export class ContextGuard implements CanActivate {
  private readonly logger = new Logger(ContextGuard.name);

  constructor(
    private readonly cls: ClsService,
    private readonly permissionsService: PermissionsService,
    private readonly abilityFactory: AbilityFactory,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();

    this.logger.debug(
      `Intercepting request to ${request.method} ${request.url}: user=${request?.session?.user?.id}, apiKey=${request.apiKey?.id}`,
    );

    if (request.session?.user?.id) {
      const userGraph = await this.permissionsService.getUserRoleGraph(request.session.user.id);
      const ability = this.abilityFactory.createForUser(userGraph);

      this.cls.set('user', userGraph);
      this.cls.set('userAbility', ability);

      const apiKey = request.apiKey;
      if (apiKey) {
        const apikeyAbility = this.abilityFactory.createForApiKey(apiKey);
        this.cls.set('apiKeyAbility', apikeyAbility);
      }
    }

    return true;
  }
}

interface RequestWithUser extends Request {
  session: {
    user: {
      id: string;
    };
  };
  apiKey?: ApikeyWithScopes;
}
