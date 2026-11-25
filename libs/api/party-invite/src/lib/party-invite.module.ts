import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { EventModule } from '@bge/event';
import { HouseholdModule } from '@bge/household';
import { InvitesModule } from '@bge/invites';
import { Module } from '@nestjs/common';
import { PartyInviteController } from './party-invite.controller';
import { PartyInviteService } from './party-invite.service';

/**
 * The party routes under `/invites` (#742): the inbox, the sent list, and
 * accept, decline and withdraw, for every kind of invite. InvitesModule
 * supplies InviteService, whose party read tells the service an invite's type;
 * each context's module supplies the responder for its kind (HouseholdModule,
 * HouseholdInviteResponder; EventModule, EventInviteResponder).
 * AuditContextModule supplies the acting user.
 */
@Module({
  imports: [DatabaseModule, InvitesModule, AuditContextModule, HouseholdModule, EventModule],
  controllers: [PartyInviteController],
  providers: [PartyInviteService],
})
export class PartyInviteModule {}
