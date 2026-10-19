import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { InvitesModule } from '@bge/invites';
import { NotificationsServiceModule } from '@bge/notifications-service';
import { QuotaModule } from '@bge/quota';
import { Module } from '@nestjs/common';
import { HouseholdController } from './household.controller';
import { HouseholdService } from './household.service';
import { HouseholdInviteController } from './invite/household-invite.controller';
import { HouseholdInviteService } from './invite/household-invite.service';
import { PartyInviteController } from './invite/party-invite.controller';
import { PartyInviteService } from './invite/party-invite.service';
import { HouseholdNotificationListener } from './listeners/household-notification.listener';
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
  // AuditContextModule supplies AuditContextService to the accept and the
  // inbox, which refuse every actor but a session user (#163).
  // NotificationsServiceModule supplies NotificationsService to the
  // notification listener, which tells invitees, and household owners and
  // admins, about the household's invites (#167).
  imports: [DatabaseModule, QuotaModule, InvitesModule, AuditContextModule, NotificationsServiceModule],
  controllers: [
    HouseholdController,
    HouseholdMemberController,
    HouseholdInviteController,
    PartyInviteController,
    HouseholdQuotaController,
  ],
  providers: [
    HouseholdService,
    HouseholdMemberService,
    HouseholdInviteService,
    PartyInviteService,
    HouseholdNotificationListener,
  ],
  exports: [HouseholdService, HouseholdMemberService],
})
export class HouseholdModule {}
