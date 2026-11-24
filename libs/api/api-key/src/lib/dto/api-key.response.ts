import { PaginatedResponseDto } from '@bge/shared';
import { ApiProperty } from '@nestjs/swagger';
import type { ApiKeyScopeView, ApiKeyView, CurrentApiKeyView } from '../api-key.service';

/** One key scope as its owner reads it (#1418). */
export class ApiKeyScopeResponse implements ApiKeyScopeView {
  @ApiProperty({ description: "The permission's stable name, such as read:game." })
  slug!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The one record the key scope reaches, or null for every record your own permissions reach.',
  })
  resourceId!: string | null;
}

/** An API key as its owner reads it (#1418). The secret is never part of it. */
export class ApiKeyResponse implements ApiKeyView {
  @ApiProperty({ description: "The key's id, which the edit and delete routes take." })
  id!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The name that tells your keys apart.' })
  name!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "The secret's first characters, so you can tell which key a program holds.",
  })
  start!: string | null;

  @ApiProperty({
    type: [ApiKeyScopeResponse],
    description:
      'What the key may do, sorted by permission slug. A key scope over a retired permission is not listed, ' +
      'since it confers nothing.',
  })
  scopes!: ApiKeyScopeResponse[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the key stops working.',
  })
  expiresAt!: Date | null;

  @ApiProperty({ description: 'false once you disable the key: it is then refused on every request.' })
  enabled!: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the key last authenticated a request, or null if it never has.',
  })
  lastUsedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

/** The calling key as it reads itself (#1418). */
export class CurrentApiKeyResponse extends ApiKeyResponse implements CurrentApiKeyView {
  @ApiProperty({
    type: 'integer',
    nullable: true,
    description:
      'Whole seconds until the key stops working, worked out by the server when it answers, so a client with a ' +
      'wrong clock reads them right.',
  })
  secondsRemaining!: number | null;
}

/** `GET /api/api-keys/current`'s body (#1418). */
export class CurrentApiKeyBodyResponse {
  @ApiProperty({ type: CurrentApiKeyResponse })
  apiKey!: CurrentApiKeyResponse;
}

/** `GET /api/api-keys/:id`'s body (#1418). */
export class ApiKeyBodyResponse {
  @ApiProperty({ type: ApiKeyResponse })
  apiKey!: ApiKeyResponse;
}

/** `POST /api/api-keys`'s body (#1418). */
export class CreatedApiKeyResponse {
  @ApiProperty({ description: 'That the key was created, in the language of the request.' })
  message!: string;

  @ApiProperty({ type: ApiKeyResponse })
  apiKey!: ApiKeyResponse;

  @ApiProperty({
    description:
      'The key itself, which a program sends in the x-api-key header. This is the only time it can be read: the ' +
      'server keeps only a hash. Store it somewhere safe now.',
  })
  secret!: string;
}

/** `PATCH /api/api-keys/:id`'s body (#1418). */
export class UpdatedApiKeyResponse {
  @ApiProperty({ description: 'That the key was updated, in the language of the request.' })
  message!: string;

  @ApiProperty({ type: ApiKeyResponse })
  apiKey!: ApiKeyResponse;
}

/** `DELETE /api/api-keys/:id`'s body (#1418). */
export class DeletedApiKeyResponse {
  @ApiProperty({ description: 'That the key was deleted, in the language of the request.' })
  message!: string;
}

/** `GET /api/api-keys`'s body: one page of your keys under `apiKeys` (#1418). */
export const PaginatedApiKeysResponse = PaginatedResponseDto(ApiKeyResponse, 'apiKeys');
