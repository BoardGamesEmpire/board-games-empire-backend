import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { InviteService } from './invite.service';

/**
 * The polymorphic invite primitive (#161). Exported so any domain module that
 * owns an invite context (households now, events and campaigns later) can
 * inject `InviteService` and drive the lifecycle inside its own transaction.
 *
 * `DatabaseModule` is imported for the party read, which takes no transaction,
 * and for one write that must NOT share the caller's transaction: stamping
 * `Expired` on a row a transition met expired, which has to outlive the
 * refusal the transition then throws. EventEmitter2 is provided globally by
 * the app's EventEmitterModule.
 */
@Module({
  imports: [DatabaseModule],
  providers: [InviteService],
  exports: [InviteService],
})
export class InvitesModule {}
