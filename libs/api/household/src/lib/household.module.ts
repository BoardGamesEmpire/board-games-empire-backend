import { DatabaseModule } from '@bge/database';
import { InvitesModule } from '@bge/invites';
import { NotificationsServiceModule } from '@bge/notifications-service';
import { QuotaModule } from '@bge/quota';
import { Module } from '@nestjs/common';
import { AdminHouseholdController } from './admin/admin-household.controller';
import { AdminHouseholdService } from './admin/admin-household.service';
import { HouseholdBanController } from './ban/household-ban.controller';
import { HouseholdBanService } from './ban/household-ban.service';
import { HouseholdEventPublisher } from './events/household-event.publisher';
import { HouseholdGamePoolService } from './game-pool/household-game-pool.service';
import { HouseholdGameShareController } from './game-share/household-game-share.controller';
import { HouseholdGameShareService } from './game-share/household-game-share.service';
import { HouseholdController } from './household.controller';
import { HouseholdService } from './household.service';
import { HouseholdInviteResponder } from './invite/household-invite-responder';
import { HouseholdInviteController } from './invite/household-invite.controller';
import { HouseholdInviteService } from './invite/household-invite.service';
import { HouseholdNotificationListener } from './listeners/household-notification.listener';
import { CollectionSharingController } from './member/collection-sharing.controller';
import { CollectionSharingService } from './member/collection-sharing.service';
import { HouseholdMemberController } from './member/household-member.controller';
import { HouseholdMemberService } from './member/household-member.service';
import { HouseholdQuotaController } from './quota/household-quota.controller';

@Module({
  // QuotaModule supplies QuotaService to the member-creation seam, which gates
  // `household_member_count` inside the caller's transaction (#159), and to
  // the invite create and approve, which gate `household_invite_daily_count`
  // in their own (#279, #166), and to the household's quota list (#515).
  // InvitesModule supplies InviteService, the only writer of an invite's
  // status; the soft delete revokes a household's outstanding invites through
  // it (#161), and the invite routes create and accept through it (#162,
  // #163).
  // NotificationsServiceModule supplies NotificationsService to the
  // notification listener, which tells invitees, and household owners and
  // admins, about the household's invites (#167).
  imports: [DatabaseModule, QuotaModule, InvitesModule, NotificationsServiceModule],
  controllers: [
    HouseholdController,
    HouseholdMemberController,
    CollectionSharingController,
    HouseholdInviteController,
    HouseholdQuotaController,
    HouseholdBanController,
    HouseholdGameShareController,
    AdminHouseholdController,
  ],
  providers: [
    HouseholdService,
    AdminHouseholdService,
    HouseholdMemberService,
    CollectionSharingService,
    HouseholdInviteService,
    HouseholdInviteResponder,
    HouseholdGameShareService,
    HouseholdNotificationListener,
    HouseholdBanService,
    HouseholdGamePoolService,
    // Every household domain event, and its webhook, goes out through it
    // after commit (#245). The lib's own, so the module doesn't export it.
    HouseholdEventPublisher,
  ],
  // The party routes (#742) hand a household invite to HouseholdInviteResponder.
  exports: [HouseholdService, HouseholdMemberService, HouseholdInviteResponder],
})
export class HouseholdModule {}
