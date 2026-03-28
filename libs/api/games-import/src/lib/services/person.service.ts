import { DatabaseService } from '@bge/database';
import type { PersonData, PublisherData } from '@board-games-empire/proto-gateway';
import { Injectable } from '@nestjs/common';

/**
 * Handles dedup + upsert for Artist, Designer, and Publisher.
 *
 * Persons are deduped by gateway link table (gatewayId + externalId) only.
 * If no link exists, a new canonical record is created.
 *
 * No pg_trgm fuzzy matching here: person names are too ambiguous across
 * platforms (e.g. "Antoine Bauza" and "A. Bauza" should NOT auto-merge).
 * First-importer-wins; enrichment jobs can fill remaining gaps later.
 */
@Injectable()
export class PersonUpsertService {
  constructor(private readonly db: DatabaseService) {}

  async upsertArtist(data: PersonData, gatewayId: string): Promise<string> {
    const link = await this.db.artistGatewayLink.findUnique({
      where: { gatewayId_externalId: { gatewayId, externalId: data.externalId } },
      select: { artistId: true },
    });

    if (link) {
      return link.artistId;
    }

    const artist = await this.db.artist.create({
      data: {
        name: data.name,
        gatewayLinks: {
          create: { gatewayId, externalId: data.externalId },
        },
      },
      select: { id: true },
    });

    return artist.id;
  }

  async upsertDesigner(data: PersonData, gatewayId: string): Promise<string> {
    const link = await this.db.designerGatewayLink.findUnique({
      where: { gatewayId_externalId: { gatewayId, externalId: data.externalId } },
      select: { designerId: true },
    });

    if (link) {
      return link.designerId;
    }

    const designer = await this.db.designer.create({
      data: {
        name: data.name,
        gatewayLinks: {
          create: { gatewayId: data.externalId, externalId: data.externalId },
        },
      },
      select: { id: true },
    });

    return designer.id;
  }

  async upsertPublisher(data: PublisherData, gatewayId: string): Promise<string> {
    const link = await this.db.publisherGatewayLink.findUnique({
      where: { gatewayId_externalId: { gatewayId, externalId: data.externalId } },
      select: { publisherId: true },
    });

    if (link) {
      return link.publisherId;
    }

    const publisher = await this.db.publisher.create({
      data: {
        name: data.name,
        website: data.website ?? undefined,
        gatewayLinks: {
          create: { gatewayId: data.externalId, externalId: data.externalId },
        },
      },
      select: { id: true },
    });

    return publisher.id;
  }
}
