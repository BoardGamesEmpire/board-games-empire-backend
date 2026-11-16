import { AuditContextService } from '@bge/actor-context';
import { Controller, Get, Header } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { ServerDiscoveryDto } from './dto/server-discovery.dto';
import { ServerDiscoveryService } from './server-discovery.service';

/**
 * Signed-in server discovery (#78), at the path the bge-identity document's
 * `bge_server_discovery_endpoint` names. A controller test pins this route to
 * that path under the api's `api` prefix, and an e2e test follows the pointer.
 *
 * No policy check: what the server offers is a fact of the server that any
 * signed-in actor may read, as with `GET /users/me`, so there is no
 * permission to hold and nothing to hide from a narrower role. An anonymous
 * user gets the same answer as a registered one; #488 decides otherwise if a
 * difference is ever needed.
 *
 * `private, no-cache`, for the freshness reasoning of the bge-identity document
 * (#585): a plugin switched off must not stay listed in a cached copy, and an
 * answer read under one session is no shared cache's to keep. `no-cache` makes
 * a client revalidate on every use, and the ETag Express sets lets an unchanged
 * document answer 304 without its body. The route stays out of the api's
 * response cache for the same reason.
 *
 * Keys are camelCase, like the rest of the API. The snake_case of the
 * bge-identity document follows the auth discovery conventions it is modeled
 * on, which do not apply here.
 */
@ApiTags('discovery')
@ApiBearerAuth()
@ApiSecurity('api_key')
@Controller('discovery')
export class DiscoveryController {
  constructor(
    private readonly serverDiscovery: ServerDiscoveryService,
    private readonly auditContext: AuditContextService,
  ) {}

  @Get('server')
  @Header('Cache-Control', 'private, no-cache')
  @ApiOperation({
    summary: 'What this server offers a signed-in user',
    description:
      'The fuller view of server discovery, for any signed-in user, anonymous users included. ' +
      '`discoverySchemaVersion` is bumped only on a breaking change to this document. ' +
      '`coreAreas` holds a key for each core area the server ships, `true` when the server offers it; the ' +
      'server works these out from its own state, and a client reads a missing key as not offered. ' +
      '`serverPlugins` lists the plugins running at server scope, ordered by slug, each with its plugin ' +
      "category and its display name in the request's language. A plugin switched off, uninstalled, failed at load, " +
      'or whose plugin manifest can no longer be read is not listed. The response is private and ' +
      'revalidated on every use, so a change shows on the next read.',
  })
  @ApiOkResponse({ type: ServerDiscoveryDto, description: 'What this server offers' })
  @ApiResponse({ status: Http.Unauthorized, description: 'The request is not signed in' })
  getServer(): Promise<ServerDiscoveryDto> {
    return this.serverDiscovery.getServerDiscovery(this.auditContext.getLocale() ?? undefined);
  }
}
