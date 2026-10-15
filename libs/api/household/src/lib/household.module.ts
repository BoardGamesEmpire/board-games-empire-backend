import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { InvitesModule } from '@bge/invites';
import { QuotaModule } from '@bge/quota';
import { Module } from '@nestjs/common';
import { HouseholdController } from './household.controller';
import { HouseholdService } from './household.service';
import { HouseholdInviteController } from './invite/household-invite.controller';
import { HouseholdInviteService } from './invite/household-invite.service';
import { PartyInviteController } from './invite/party-invite.controller';
import { PartyInviteService } from './invite/party-invite.service';
import { HouseholdMemberController } from './member/household-member.controller';
import { HouseholdMemberService } from './member/household-member.service';

@Module({
  // QuotaModule supplies QuotaService to the member-creation seam, which gates
  // `household_member_count` inside the caller's transaction (#159), and to
  // the invite create, which gates `household_invite_daily_count` in its own
  // (#279).
  // InvitesModule supplies InviteService, the only writer of an invite's
  // status; the soft delete revokes a household's outstanding invites through
  // it (#161), and the invite routes create through it (#162).
  // AuditContextModule supplies AuditContextService to the inbox, which
  // refuses every actor but a session user (#163).
  imports: [DatabaseModule, QuotaModule, InvitesModule, AuditContextModule],
  controllers: [HouseholdController, HouseholdMemberController, HouseholdInviteController, PartyInviteController],
  providers: [HouseholdService, HouseholdMemberService, HouseholdInviteService, PartyInviteService],
  exports: [HouseholdService, HouseholdMemberService],
})
export class HouseholdModule {}
