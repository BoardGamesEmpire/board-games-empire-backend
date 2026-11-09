import { DatabaseService, type PluginArtifact } from '@bge/database';
import type { PluginArtifactSha256 } from '@boardgamesempire/plugin-contract';
import { Injectable } from '@nestjs/common';

/** A received plugin artifact expires 7 days after it was posted or last refreshed (#1094). */
export const PLUGIN_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RecordReceivedArtifactInput {
  readonly sha256: PluginArtifactSha256;
  readonly slug: string;
  readonly version: string;
  readonly compressedBytes: number;
  readonly url: string | null;
  readonly registrySlug: string | null;
  readonly receivedById: string;
}

/** The `PluginArtifact` rows: one per distinct received archive, keyed by checksum (#1094). */
@Injectable()
export class PluginArtifactStore {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Records a receipt. Posting the same archive again keeps one row and
   * moves it to the latest receipt: expiry, link, registry and sender. The
   * slug, version and size cannot differ for the same checksum.
   */
  recordReceived(input: RecordReceivedArtifactInput, now: Date): Promise<PluginArtifact> {
    const expiresAt = this.expiryFrom(now);
    const { sha256, slug, version, compressedBytes, url, registrySlug, receivedById } = input;

    return this.db.pluginArtifact.upsert({
      where: { sha256 },
      create: { sha256, slug, version, compressedBytes, url, registrySlug, receivedById, receivedAt: now, expiresAt },
      update: { expiresAt, url, registrySlug, receivedById, receivedAt: now },
    });
  }

  /** The row, unless it has expired. */
  findLive(sha256: PluginArtifactSha256, now: Date): Promise<PluginArtifact | null> {
    return this.db.pluginArtifact.findFirst({ where: { sha256, expiresAt: { gt: now } } });
  }

  /**
   * Reads the row for an install and moves its expiry forward. The guard on
   * `expiresAt` makes an expired row (which the sweep may be deleting) read
   * as absent, so an install never starts from a row about to vanish.
   */
  async refreshForInstall(sha256: PluginArtifactSha256, now: Date): Promise<PluginArtifact | null> {
    const { count } = await this.db.pluginArtifact.updateMany({
      where: { sha256, expiresAt: { gt: now } },
      data: { expiresAt: this.expiryFrom(now) },
    });

    return count === 0 ? null : this.db.pluginArtifact.findUnique({ where: { sha256 } });
  }

  /** A missing row is fine. */
  async remove(sha256: PluginArtifactSha256): Promise<void> {
    await this.db.pluginArtifact.deleteMany({ where: { sha256 } });
  }

  private expiryFrom(now: Date): Date {
    return new Date(now.getTime() + PLUGIN_ARTIFACT_TTL_MS);
  }
}
