import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { HouseholdController } from './household.controller';
import { HouseholdService } from './household.service';
import { HouseholdMemberController } from './member/household-member.controller';
import { HouseholdMemberService } from './member/household-member.service';

@Module({
  imports: [DatabaseModule],
  controllers: [HouseholdController, HouseholdMemberController],
  providers: [HouseholdService, HouseholdMemberService],
  exports: [HouseholdService, HouseholdMemberService],
})
export class HouseholdModule {}
