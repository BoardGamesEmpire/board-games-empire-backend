import { DatabaseService, NotificationType, type DataGateway } from '@bge/database';
import { findServerAdminIds, NotificationsService } from '@bge/notifications-service';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { GatewayCapabilitiesChangedEvent, GatewayDisabledEvent } from '../events/gateway-registry.events';

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
 * failures auto-disable one, and when an interview finds capabilities gone
 * that the server was routing.
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

  /**
   * Only a capability that's gone notifies. One that's gained is routed at
   * once and needs nothing from a server admin (#709), so a first interview,
   * whose before is empty, never notifies either. A capability a server admin
   * switched off (#715) isn't routed whether it's declared or not, so it's
   * left out, and nothing is sent when only those are gone.
   *
   * The repeat check reads the database, so it holds across processes, and
   * it's per server admin: one whose unread notification for the DataGateway
   * already names every capability lost now, among any others, isn't told
   * again, and one who has read theirs is, whoever else hasn't. A loss that
   * names a capability no unread notification does is told. The check is a
   * read before the write, not a lock: two handlers overlapping on one
   * DataGateway could each send a copy, which takes the same capability
   * coming back and going again within one handler's few queries.
   */
  @OnEvent(GatewayCapabilitiesChangedEvent.eventName, { async: true })
  async onCapabilitiesChanged(event: GatewayCapabilitiesChangedEvent): Promise<void> {
    const gatewayId = event.after.id;
    const remaining = event.after.capabilities;
    const gone = event.before.capabilities.filter((capability) => !remaining.includes(capability));

    if (gone.length === 0) {
      return;
    }

    try {
      const gateway = await this.liveGateway(gatewayId);

      if (!gateway) {
        return;
      }

      const lost = gone.filter((capability) => !gateway.disabledCapabilities.includes(capability));

      if (lost.length === 0) {
        return;
      }

      const adminIds = await findServerAdminIds(this.db);

      if (adminIds.length === 0) {
        this.logger.warn(`No server admins to tell that DataGateway ${gatewayId} lost [${lost.join(', ')}]`);
        return;
      }

      // Scoped to the server admins' ids so the query enters through the
      // leading column of the (userId, read, createdAt) index instead of
      // scanning the whole notifications table for the JSON payload match.
      const pending = await this.db.notification.findMany({
        where: {
          userId: { in: adminIds },
          read: false,
          type: NotificationType.DataGatewayCapabilitiesLost,
          AND: [
            { payload: { path: ['gatewayId'], equals: gatewayId } },
            { payload: { path: ['lostCapabilities'], array_contains: lost } },
          ],
        },
        select: { userId: true },
      });
      const alreadyTold = new Set(pending.map((notification) => notification.userId));
      const toTell = adminIds.filter((userId) => !alreadyTold.has(userId));

      if (toTell.length === 0) {
        return;
      }

      await this.notifications.createMany(
        toTell.map((userId) => ({
          userId,
          type: NotificationType.DataGatewayCapabilitiesLost,
          payload: { gatewayId, gatewayName: gateway.name, lostCapabilities: lost },
        })),
      );

      this.logger.log(`Told ${toTell.length} server admin(s) that DataGateway ${gatewayId} lost [${lost.join(', ')}]`);
    } catch (err) {
      this.logger.error(
        `Failed to tell the server admins that DataGateway ${gatewayId} lost capabilities`,
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
