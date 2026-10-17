import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { InvitesModule } from '../invites.module';
import { InviteExpirySweepService } from './sweep.service';

/**
 * Worker-only (mirrors `MediaSweepModule` and `AuditRetentionModule`): hosts
 * the invite expiry sweep so its interval runs in exactly one process. Kept
 * apart from `InvitesModule`, which the api reaches through its consumers and
 * so must schedule nothing. Requires the host to register
 * ScheduleModule.forRoot(), a global ClsModule and the global
 * EventEmitterModule (the worker does all three).
 */
@Module({
  imports: [AuditContextModule, DatabaseModule, InvitesModule],
  providers: [InviteExpirySweepService],
  exports: [InviteExpirySweepService],
})
export class InviteExpirySweepModule {}
