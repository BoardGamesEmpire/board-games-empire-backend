import type { GameReleaseData } from '@boardgamesempire/proto-gateway';
import { Injectable, Logger } from '@nestjs/common';
import { toEditionKey } from './helpers';

/**
 * Pure orchestration helper — no DB access. Takes the batch of releases
 * for a single PlatformGame and computes parent hierarchy
 * resolution before any writes happen.
 *
 * Stateless and side-effect-free aside from logging; injectable for test
 * substitution and to keep the import worker's transaction boundary clean.
 */
@Injectable()
export class ReleaseGraphResolver {
  private readonly logger = new Logger(ReleaseGraphResolver.name);

  /**
   * Pre-resolves a batch of releases for a single PlatformGame:
   *  - Builds the parent map by resolving parent_edition_external_id
   *    references against the editionKeys present in this batch.
   *
   * Releases whose parent_edition_external_id does not match any
   * editionKey in this batch are not added to the parent map; their
   * parentReleaseId will be null. A warning is logged so unresolvable
   * references surface in operations.
   */
  preResolve(releases: readonly GameReleaseData[]): ReadonlyMap<string, string> {
    const knownEditionKeys = new Set(releases.map((r) => this.editionKeyOf(r)));
    const parentMap = new Map<string, string>();

    for (const release of releases) {
      const parentExternalId = release.parentEditionExternalId;
      if (!parentExternalId) {
        continue;
      }

      const childKey = this.editionKeyOf(release);
      if (!knownEditionKeys.has(parentExternalId)) {
        this.logger.warn(
          `Release editionKey=${childKey} references unknown parent_edition_external_id=` +
            `${parentExternalId}; will be persisted with parentReleaseId=null.`,
        );
        continue;
      }

      if (parentExternalId === childKey) {
        this.logger.warn(`Release editionKey=${childKey} references itself as parent; ignoring.`);
        continue;
      }

      parentMap.set(childKey, parentExternalId);
    }

    return parentMap;
  }

  private editionKeyOf(release: GameReleaseData): string {
    return toEditionKey(release.externalId);
  }
}
