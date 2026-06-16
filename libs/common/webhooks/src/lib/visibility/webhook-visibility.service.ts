import { DatabaseService, ResourceType } from '@bge/database';
import type { AppAbility } from '@bge/permissions';
import { accessibleBy } from '@casl/prisma';
import { Injectable } from '@nestjs/common';

/**
 * Decides whether a subscriber may receive an event about a given subject
 * instance, by asking the exact same question the REST read path asks: does a
 * row with this id exist that is `accessibleBy` the subscriber's ability?
 *
 * This is the whole point of the CASL-at-dispatch design — webhook audience is
 * never a parallel rule set, it is live read-authorization. As the read rules
 * tighten (game visibility, event participation, #87 ban enforcement), webhook
 * audiences narrow automatically with zero changes here.
 *
 * The per-subject switch is deliberate over a dynamic `db[model]` lookup: it
 * keeps every branch fully typed and fails loudly for an unmapped subject
 * rather than silently delivering. New subjects are added as the registry
 * grows (Game lands with the worker-side dispatcher).
 */
@Injectable()
export class WebhookVisibilityService {
  constructor(private readonly db: DatabaseService) {}

  async isVisibleTo(subject: ResourceType, subjectId: string, ability: AppAbility): Promise<boolean> {
    switch (subject) {
      case ResourceType.Event: {
        const count = await this.db.event.count({
          where: {
            id: subjectId,
            deletedAt: null,
            AND: [accessibleBy(ability).ofType(subject)],
          },
        });

        return count > 0;
      }

      default:
        throw new Error(`No webhook visibility check implemented for subject "${subject}"`);
    }
  }
}
