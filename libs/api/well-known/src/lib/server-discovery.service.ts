import { PluginInventoryService } from '@bge/plugin';
import { Injectable } from '@nestjs/common';
import { SERVER_DISCOVERY_SCHEMA_VERSION } from './constants';
import { RunningServerPluginDto, ServerCoreAreasDto, ServerDiscoveryDto } from './dto/server-discovery.dto';

/**
 * Builds signed-in server discovery (#78): the core areas the server offers
 * and the plugins running on it at server scope. Both are worked out from the
 * server's state on every read; nothing here is cached, so a plugin switched
 * off is gone from the next answer.
 */
@Injectable()
export class ServerDiscoveryService {
  constructor(private readonly inventory: PluginInventoryService) {}

  async getServerDiscovery(locale?: string): Promise<ServerDiscoveryDto> {
    const running = await this.inventory.listRunningOnServer(locale);

    const dto = new ServerDiscoveryDto();
    dto.discoverySchemaVersion = SERVER_DISCOVERY_SCHEMA_VERSION;
    dto.coreAreas = this.coreAreas();
    dto.serverPlugins = running.map((plugin) => {
      const entry = new RunningServerPluginDto();
      entry.slug = plugin.slug;
      entry.category = plugin.category;
      entry.displayName = plugin.displayName;

      return entry;
    });

    return dto;
  }

  /**
   * The core areas, each decided by the server and never by an admin switch.
   * The three below always ship today, so each is `true`. An area whose
   * answer depends on the server's state, such as push notifications once
   * they ship (#186), resolves that state here.
   */
  private coreAreas(): ServerCoreAreasDto {
    const coreAreas = new ServerCoreAreasDto();
    coreAreas.households = true;
    coreAreas.events = true;
    coreAreas.friendships = true;

    return coreAreas;
  }
}
