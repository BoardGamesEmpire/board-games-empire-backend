import { DatabaseModule } from '@bge/database';
import { InvitesModule } from '@bge/invites';
import { QuotaModule } from '@bge/quota';
import { Module } from '@nestjs/common';
import { HouseholdController } from './household.controller';
import { HouseholdService } from './household.service';
import { HouseholdMemberController } from './member/household-member.controller';
import { HouseholdMemberService } from './member/household-member.service';

@Module({
  // QuotaModule supplies QuotaService to the member-creation seam, which gates
  // `household_member_count` inside the caller's transaction (#159).
  // InvitesModule supplies InviteService, the only writer of an invite's
  // status; the soft delete revokes a household's outstanding invites through
  // it (#161).
  imports: [DatabaseModule, QuotaModule, InvitesModule],
  controllers: [HouseholdController, HouseholdMemberController],
  providers: [HouseholdService, HouseholdMemberService],
  exports: [HouseholdService, HouseholdMemberService],
})
export class HouseholdModule {}
