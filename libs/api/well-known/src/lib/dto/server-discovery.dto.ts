import { PluginCategory } from '@bge/database';
import { ApiProperty } from '@nestjs/swagger';

/**
 * The core areas this server offers (#78), worked out by the server from its
 * own state and never switched by an admin.
 *
 * The contract a client reads it by:
 * - A key is present for each core area this server ships, `true` or `false`
 *   by the server's state.
 * - A client reads an absent key as `false`, so an older server that predates
 *   an area is read correctly by a newer client.
 * - Keys are the glossary's nouns in the plural.
 */
export class ServerCoreAreasDto {
  @ApiProperty({
    description:
      'Households: trust groups of any size whose members share their games and plan play together. ' +
      'Living together is not required.',
    example: true,
  })
  households!: boolean;

  @ApiProperty({ description: 'Events: gatherings to play games, such as a game night.', example: true })
  events!: boolean;

  @ApiProperty({
    description: 'Friendships: users sending friend requests, and sharing with the friends who accept them.',
    example: true,
  })
  friendships!: boolean;
}

/** A plugin running on this server at server scope (#78). */
export class RunningServerPluginDto {
  @ApiProperty({ description: "The plugin's unique slug", example: 'bgg-gateway' })
  slug!: string;

  @ApiProperty({
    enum: PluginCategory,
    enumName: 'PluginCategory',
    description: 'The plugin category: the kind of extension point the plugin fills',
  })
  category!: PluginCategory;

  @ApiProperty({
    description:
      "The plugin's display name in the request's language, or in the server's default language " +
      'when the plugin does not provide that one',
    example: 'BoardGameGeek',
  })
  displayName!: string;
}

/**
 * Signed-in server discovery (#78): what a server tells a signed-in client
 * about itself beyond the bge-identity document at `/.well-known/bge-identity`.
 * Keys are camelCase, like the rest of the API.
 */
export class ServerDiscoveryDto {
  /**
   * Schema version of this document, versioned apart from the bge-identity
   * document. Clients parse known fields and ignore unknown ones; bumped only
   * on a breaking shape change.
   */
  @ApiProperty({ description: 'Schema version of this document', example: 1 })
  discoverySchemaVersion!: number;

  @ApiProperty({
    type: ServerCoreAreasDto,
    description: 'The core areas this server offers. A client reads a missing key as not offered.',
  })
  coreAreas!: ServerCoreAreasDto;

  @ApiProperty({
    type: [RunningServerPluginDto],
    description: 'The plugins running on this server at server scope, ordered by slug',
  })
  serverPlugins!: RunningServerPluginDto[];
}
