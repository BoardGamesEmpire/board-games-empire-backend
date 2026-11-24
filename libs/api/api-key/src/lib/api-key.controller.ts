import { AuditContextService, sessionUserId } from '@bge/actor-context';
import { t } from '@bge/i18n';
import { paginated, Unscoped } from '@bge/shared';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import type { Observable } from 'rxjs';
import { from, map } from 'rxjs';
import { API_KEY_EXPIRY_DEFAULT_DAYS, API_KEY_EXPIRY_MAX_DAYS, API_KEY_EXPIRY_MIN_DAYS } from './api-key.constants';
import { apiKeyRequired, apiKeySessionRequired } from './api-key.errors';
import { ApiKeyService } from './api-key.service';
import {
  ApiKeyBodyResponse,
  CreatedApiKeyResponse,
  CurrentApiKeyBodyResponse,
  DeletedApiKeyResponse,
  PaginatedApiKeysResponse,
  UpdatedApiKeyResponse,
} from './dto/api-key.response';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import type { GrantablePermissionEntry } from './dto/grantable-permission.response';
import { GrantablePermissionsResponse, toGrantablePermissionEntry } from './dto/grantable-permission.response';
import { ListApiKeysQueryDto } from './dto/list-api-keys.query.dto';
import { UpdateApiKeyDto } from './dto/update-api-key.dto';

/** The key list holds no permissioned resource, and only its owner, signed in, may read it (#1418). */
const API_KEYS_SCOPE = Unscoped(
  "a user's own API keys, filtered by owner (an API key is not a ResourceType), and an API key is refused at " +
    'this route, so only the owner, signed in, lists their keys and no delegated ceiling is dropped',
);

const UNAUTHORIZED_DESCRIPTION = 'Authentication required';

const SESSION_REQUIRED_DESCRIPTION =
  'API_KEY_SESSION_REQUIRED: only you, signed in, can manage your API keys. An API key cannot, whatever it may do.';

const NOT_FOUND_DESCRIPTION =
  "API_KEY_NOT_FOUND: you have no API key with that id. Another user's key gets the same answer.";

const SCOPES_UNPROCESSABLE_DESCRIPTION =
  'API_KEY_SCOPE_NOT_GRANTABLE (slug names it): a permission the catalog lacks, or one you may not hand a key. ' +
  'API_KEY_SCOPE_NOT_PINNABLE (slug names it): a record named for a permission that cannot be limited to one. ' +
  'API_KEY_EXPIRY_OUT_OF_RANGE (min and max give the range): expiresInDays is outside ' +
  `${API_KEY_EXPIRY_MIN_DAYS} to ${API_KEY_EXPIRY_MAX_DAYS}. ` +
  'API_KEY_CRITICAL_NEEDS_CONFIRMATION: the key would gain a Critical permission without confirmCritical: true.';

/**
 * A user's own API keys (#1417, #1418): what a key of theirs may hold, and
 * creating, listing, reading, editing and deleting their keys.
 *
 * Every route but `/current` is the signed-in user's in person: an API key
 * acts for its owner but is not the owner, so a key of any key scope could
 * otherwise mint a wider or longer-lived key, or read or shape the authority
 * its owner hands to keys. The actor-kind check is the gate, and no policy
 * check is needed on top, because every signed-in user manages their own.
 *
 * `/current` is the exception: only a key may call it, and it describes the
 * calling key. Reading itself isn't managing keys.
 *
 * `grantable` and `current` are declared before the `:id` routes, so neither
 * is read as a key id. Nothing here is in the response cache: a key's edit, or
 * an owner's role change, must show on the next read.
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
  @ApiResponse({ status: Http.Unauthorized, description: UNAUTHORIZED_DESCRIPTION })
  @ApiResponse({ status: Http.Forbidden, description: SESSION_REQUIRED_DESCRIPTION })
  @Get('grantable')
  grantable(): Observable<{ readonly permissions: GrantablePermissionEntry[] }> {
    const userId = this.sessionUser();

    return from(this.apiKeys.grantableFor(userId)).pipe(
      map((grantable) => ({ permissions: grantable.map(toGrantablePermissionEntry) })),
    );
  }

  @ApiOperation({
    summary: 'Read the API key making this request',
    description:
      "The calling key's name, start, expiry, the whole seconds left until it expires, and its key scopes. Never " +
      'its secret. Only an API key can call it. An expired or disabled key never reaches it: it is refused as an ' +
      'invalid key.',
  })
  @ApiSecurity('api_key')
  @ApiResponse({ status: Http.Ok, type: CurrentApiKeyBodyResponse })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required, or the API key is not valid' })
  @ApiResponse({
    status: Http.Forbidden,
    description: 'API_KEY_REQUIRED: only an API key can read itself. A signed-in user has no calling key.',
  })
  @ApiResponse({ status: Http.NotFound, description: 'API_KEY_NOT_FOUND: the key was deleted a moment ago.' })
  @Get('current')
  current() {
    const apiKeyId = this.callingKeyId();

    return from(this.apiKeys.current(apiKeyId)).pipe(map((apiKey) => ({ apiKey })));
  }

  @ApiOperation({
    summary: 'Create an API key',
    description:
      'A key for a program to act for you, holding the key scopes you name, or every permission a key of yours ' +
      'may hold with preset everything. A key never does more than you can. It expires in expiresInDays, ' +
      `${API_KEY_EXPIRY_DEFAULT_DAYS} when left out. The answer carries the secret, the only time it can be read.`,
  })
  @ApiResponse({ status: Http.Created, type: CreatedApiKeyResponse })
  @ApiResponse({ status: Http.BadRequest, description: 'The body failed validation, naming each field' })
  @ApiResponse({ status: Http.Unauthorized, description: UNAUTHORIZED_DESCRIPTION })
  @ApiResponse({
    status: Http.Forbidden,
    description:
      `${SESSION_REQUIRED_DESCRIPTION} API_KEY_NEEDS_RECENT_SIGN_IN: giving a key a Critical permission needs ` +
      'a recent sign-in; sign in again and retry.',
  })
  @ApiResponse({
    status: Http.UnprocessableEntity,
    description: `API_KEY_SCOPES_OR_PRESET: name scopes or preset, not both. ${SCOPES_UNPROCESSABLE_DESCRIPTION}`,
  })
  @Post()
  create(@Body() dto: CreateApiKeyDto) {
    const userId = this.sessionUser();

    return from(this.apiKeys.create(userId, dto)).pipe(
      map(({ apiKey, secret }) => ({ message: t('success.api_key.created'), apiKey, secret })),
    );
  }

  @ApiOperation({
    summary: 'List your API keys',
    description:
      'Newest first, each with its name, start, expiry, enabled flag, last use and key scopes; never a secret. ' +
      'Paginated: `?page=` (1-based) and `?limit=` (default 20, max 50), with a `pagination` envelope carrying ' +
      '`total`, `totalPages` and `hasMore`.',
  })
  @ApiResponse({ status: Http.Ok, type: PaginatedApiKeysResponse })
  @ApiResponse({ status: Http.BadRequest, description: 'page or limit failed validation' })
  @ApiResponse({ status: Http.Unauthorized, description: UNAUTHORIZED_DESCRIPTION })
  @ApiResponse({ status: Http.Forbidden, description: SESSION_REQUIRED_DESCRIPTION })
  @Get()
  list(@Query() query: ListApiKeysQueryDto) {
    const userId = this.sessionUser();

    return from(this.apiKeys.list(userId, query)).pipe(
      map((page) => paginated('apiKeys', page, query, API_KEYS_SCOPE)),
    );
  }

  @ApiOperation({ summary: 'Read one of your API keys', description: 'Never its secret.' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: Http.Ok, type: ApiKeyBodyResponse })
  @ApiResponse({ status: Http.Unauthorized, description: UNAUTHORIZED_DESCRIPTION })
  @ApiResponse({ status: Http.Forbidden, description: SESSION_REQUIRED_DESCRIPTION })
  @ApiResponse({ status: Http.NotFound, description: NOT_FOUND_DESCRIPTION })
  @Get(':id')
  get(@Param('id') id: string) {
    const userId = this.sessionUser();

    return from(this.apiKeys.get(userId, id)).pipe(map((apiKey) => ({ apiKey })));
  }

  @ApiOperation({
    summary: 'Edit one of your API keys',
    description:
      'Change its name, set its expiry a number of days from now, disable or enable it, or replace its key ' +
      'scopes. A field left out stays as it is, and an empty body changes nothing. A disabled key, or one whose ' +
      'key scopes changed, is judged anew on its next request.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: Http.Ok, type: UpdatedApiKeyResponse })
  @ApiResponse({ status: Http.BadRequest, description: 'The body failed validation, naming each field' })
  @ApiResponse({ status: Http.Unauthorized, description: UNAUTHORIZED_DESCRIPTION })
  @ApiResponse({
    status: Http.Forbidden,
    description:
      `${SESSION_REQUIRED_DESCRIPTION} API_KEY_NEEDS_RECENT_SIGN_IN: adding a Critical permission needs a recent ` +
      'sign-in; sign in again and retry.',
  })
  @ApiResponse({ status: Http.NotFound, description: NOT_FOUND_DESCRIPTION })
  @ApiResponse({ status: Http.UnprocessableEntity, description: SCOPES_UNPROCESSABLE_DESCRIPTION })
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateApiKeyDto) {
    const userId = this.sessionUser();

    return from(this.apiKeys.update(userId, id, dto)).pipe(
      map((apiKey) => ({ message: t('success.api_key.updated'), apiKey })),
    );
  }

  @ApiOperation({
    summary: 'Delete one of your API keys',
    description: 'The key is refused from its next request. This cannot be undone.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: Http.Ok, type: DeletedApiKeyResponse })
  @ApiResponse({ status: Http.Unauthorized, description: UNAUTHORIZED_DESCRIPTION })
  @ApiResponse({ status: Http.Forbidden, description: SESSION_REQUIRED_DESCRIPTION })
  @ApiResponse({ status: Http.NotFound, description: NOT_FOUND_DESCRIPTION })
  @Delete(':id')
  remove(@Param('id') id: string) {
    const userId = this.sessionUser();

    return from(this.apiKeys.remove(userId, id)).pipe(map(() => ({ message: t('success.api_key.deleted') })));
  }

  /** The signed-in user's id, or 403 `API_KEY_SESSION_REQUIRED` for an API key or any other actor (#1418). */
  private sessionUser(): string {
    const userId = sessionUserId(this.auditContext.getActor());

    if (userId === null) {
      throw apiKeySessionRequired();
    }

    return userId;
  }

  /** The calling key's id, or 403 `API_KEY_REQUIRED` for a session or any other actor (#1418). */
  private callingKeyId(): string {
    const actor = this.auditContext.getActor();

    if (actor?.kind !== 'apiKey') {
      throw apiKeyRequired();
    }

    return actor.apiKeyId;
  }
}
