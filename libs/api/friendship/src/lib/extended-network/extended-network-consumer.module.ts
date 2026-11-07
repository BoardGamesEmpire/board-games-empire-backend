import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EXTENDED_NETWORK_QUEUE } from './extended-network-queue.constants';
import { ExtendedNetworkScheduleService } from './extended-network-schedule.service';
import { ExtendedNetworkProcessor } from './extended-network.processor';
import { ExtendedNetworkService } from './extended-network.service';

/**
 * Worker-only. Runs the extended network's rebuilds, and queues the full one
 * at start and daily (#497). Requires the host to register
 * `ScheduleModule.forRoot()` and a global `ClsModule` (the worker does both).
 * The API queues the per-change rebuilds through `FriendshipModule`.
 */
@Module({
  imports: [AuditContextModule, DatabaseModule, BullModule.registerQueue({ name: EXTENDED_NETWORK_QUEUE })],
  providers: [ExtendedNetworkService, ExtendedNetworkProcessor, ExtendedNetworkScheduleService],
})
export class ExtendedNetworkConsumerModule {}
