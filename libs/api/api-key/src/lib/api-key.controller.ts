import { AuditContextService, requireSessionUserId } from '@bge/actor-context';
import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import type { Observable } from 'rxjs';
import { from, map } from 'rxjs';
import { ApiKeyService } from './api-key.service';
import type { GrantablePermissionEntry } from './dto/grantable-permission.response';
import { GrantablePermissionsResponse, toGrantablePermissionEntry } from './dto/grantable-permission.response';

/**
 * A user's own API keys (#1417). #1418 adds the create route here.
 *
 * Every route is the signed-in user's in person: an API key acts for its owner
 * but is not the owner, so a key of any key scope could otherwise read or
 * shape the authority its owner hands to keys. The actor-kind check is the
 * gate, and no policy check is needed on top, because every signed-in user
 * may list their own.
 */
@ApiBearerAuth()
@ApiTags('api-keys')
@Controller('api-keys')
export class ApiKeyController {
  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly auditContext: AuditContextService,
  ) {}

  @ApiOperation({
    summary: 'List the permissions an API key of yours may hold',
    description:
      'Every permission you hold now that a key of yours may hold, each with a plain-language description in ' +
      'the language of the request, its risk level, and whether a key scope over it can be limited to one record. ' +
      'Only you, signed in, can read it: an API key cannot.',
  })
  @ApiResponse({ status: Http.Ok, type: GrantablePermissionsResponse })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({
    status: Http.Forbidden,
    description: 'API keys and other actors who are not you, signed in, are refused',
  })
  // Kept out of the response cache: a role change must show on the next read.
  @Get('grantable')
  grantable(): Observable<{ readonly permissions: GrantablePermissionEntry[] }> {
    const userId = requireSessionUserId(this.auditContext.getActor());

    return from(this.apiKeys.grantableFor(userId)).pipe(
      map((grantable) => ({ permissions: grantable.map(toGrantablePermissionEntry) })),
    );
  }
}
