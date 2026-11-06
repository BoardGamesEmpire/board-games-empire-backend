import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EXTENDED_NETWORK_QUEUE } from './extended-network/extended-network-queue.constants';
import { ExtendedNetworkProducer } from './extended-network/extended-network.producer';
import { FriendshipController } from './friendship.controller';
import { FriendshipService } from './friendship.service';

/**
 * The friendship routes. A change queues the extended network's rebuilds,
 * which the worker runs (`ExtendedNetworkConsumerModule`, #497): the queue is
 * registered here for enqueue only.
 */
@Module({
  imports: [AuditContextModule, DatabaseModule, BullModule.registerQueue({ name: EXTENDED_NETWORK_QUEUE })],
  controllers: [FriendshipController],
  providers: [FriendshipService, ExtendedNetworkProducer],
  exports: [FriendshipService],
})
export class FriendshipModule {}
