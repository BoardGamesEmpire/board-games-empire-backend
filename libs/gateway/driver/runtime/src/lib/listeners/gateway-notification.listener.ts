import { DatabaseService, NotificationType, type DataGateway } from '@bge/database';
import { findServerAdminIds, NotificationsService } from '@bge/notifications-service';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { GatewayDisabledEvent } from '../events/gateway-registry.events';

/** What a notification needs from the DataGateway's row. */
type LiveGateway = Pick<DataGateway, 'name' | 'disabledCapabilities'>;

/**
 * How much of the upstream's error an auto-disable notification keeps. The
 * registry logs each failure's whole text, so nothing is lost, and a driver
 * that passes on an upstream's HTML error page would otherwise have it stored
 * once per server admin and sent with every unread fetch.
 */
const LAST_ERROR_MAX_LENGTH = 1_000;

/** Half a surrogate pair, read one code point at a time. */
const LONE_SURROGATE = /^\p{Surrogate}$/u;

/**
 * The upstream's error as a notification can store it: its first
 * LAST_ERROR_MAX_LENGTH characters, then "…" when there were more. It's cut
 * between code points, and each character PostgreSQL refuses in JSON, a NUL
 * or half a surrogate pair, becomes U+FFFD. Reading stops at the cut, so a
 * page-long error costs no more than a short one.
 */
function storableError(text: string): string {
  const kept: string[] = [];

  for (const character of text) {
    if (kept.length === LAST_ERROR_MAX_LENGTH) {
      return `${kept.join('')}…`;
    }

    kept.push(character === '\u0000' || LONE_SURROGATE.test(character) ? '\uFFFD' : character);
  }

  return kept.join('');
}

/**
 * Tells the server admins about their DataGateways (#763): when repeated
 * failures auto-disable one.
 *
 * Only the coordinator and the gateway worker host this lib, and only the
 * process whose conditional write lands emits, so each change is told once.
 * That write has landed by the time a handler runs, so a handler never
 * throws: it logs its own failure and resolves, and the notification is lost
 * rather than the change it reports.
 */
@Injectable()
export class GatewayNotificationListener {
  private readonly logger = new Logger(GatewayNotificationListener.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * No repeat check: a DataGateway that's off can't be auto-disabled again
   * until a server admin switches it back on.
   */
  @OnEvent(GatewayDisabledEvent.eventName, { async: true })
  async onGatewayDisabled(event: GatewayDisabledEvent): Promise<void> {
    const gatewayId = event.after.id;

    try {
      const gateway = await this.liveGateway(gatewayId);

      if (!gateway) {
        return;
      }

      const adminIds = await findServerAdminIds(this.db);

      if (adminIds.length === 0) {
        this.logger.warn(`No server admins to tell that DataGateway ${gatewayId} was auto-disabled`);
        return;
      }

      const { reason, consecutiveFailures, firstFailureAt, lastFailureAt, lastError } = event.failure;

      await this.notifications.createMany(
        adminIds.map((userId) => ({
          userId,
          type: NotificationType.DataGatewayAutoDisabled,
          payload: {
            gatewayId,
            gatewayName: gateway.name,
            reason,
            consecutiveFailures,
            firstFailureAt: firstFailureAt.toISOString(),
            lastFailureAt: lastFailureAt.toISOString(),
            lastError: storableError(lastError),
          },
        })),
      );

      this.logger.log(`Told ${adminIds.length} server admin(s) that DataGateway ${gatewayId} was auto-disabled`);
    } catch (err) {
      this.logger.error(
        `Failed to tell the server admins that DataGateway ${gatewayId} was auto-disabled`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /** Its name and switched-off capabilities, or null once it's gone: absent or soft-deleted. */
  private liveGateway(gatewayId: string): Promise<LiveGateway | null> {
    return this.db.dataGateway.findFirst({
      where: { id: gatewayId, deletedAt: null },
      select: { name: true, disabledCapabilities: true },
    });
  }
}
